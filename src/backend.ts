import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  CallToolResultSchema,
  ToolSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { findInstallation, type Installation } from "./installation.js";
import { AppServerRpc, type Elicitation } from "./rpc.js";

const statusSchema = z.object({
  data: z.array(
    z.object({
      name: z.string(),
      tools: z.record(z.string(), ToolSchema),
      toolsError: z.string().nullish(),
    }),
  ),
  nextCursor: z.string().nullish(),
});
const threadSchema = z.object({ thread: z.object({ id: z.string() }) });

export interface Backend {
  tools(signal?: AbortSignal): Promise<Tool[]>;
  call(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    elicitation?: Elicitation,
  ): Promise<CallToolResult>;
  close(): Promise<void>;
}

export function launchConfig(client: string, cwd: string): string {
  return `model_provider = "bridge-disabled"
model = "no-model"
web_search = "disabled"
cli_auth_credentials_store = "file"

[model_providers.bridge-disabled]
name = "No model execution"
base_url = "http://127.0.0.1:1"
wire_api = "responses"
requires_openai_auth = false
request_max_retries = 0
stream_max_retries = 0

[features]
shell_tool = false
unified_exec = false
multi_agent = false
plugins = false
hooks = false
memories = false
remote_control = false

[analytics]
enabled = false

[history]
persistence = "none"

[mcp_servers.computer-use]
command = ${JSON.stringify(client)}
args = ["mcp"]
env_vars = ["CODEX_HOME"]
cwd = ${JSON.stringify(cwd)}
startup_timeout_sec = 30
tool_timeout_sec = 120
`;
}

export function brokerEnvironment(
  root: string,
  codexHome: string,
  codex: string,
): NodeJS.ProcessEnv {
  return {
    HOME: root,
    CODEX_HOME: codexHome,
    TMPDIR: root,
    // The signed native client also launches `codex` for its host connection.
    PATH: `${path.dirname(codex)}:/usr/bin:/bin:/usr/sbin:/sbin`,
    LANG: "en_US.UTF-8",
  };
}

export class CodexBackend implements Backend {
  private rpc?: AppServerRpc;
  private root?: string;
  private threadId?: string;
  private catalog?: Tool[];
  private starting?: Promise<void>;
  private lifetime = new AbortController();
  installation?: Installation;

  constructor(private readonly app?: string) {}

  private async start(signal?: AbortSignal): Promise<void> {
    if (!this.starting) this.lifetime = new AbortController();
    const lifetimeSignal = signal
      ? AbortSignal.any([signal, this.lifetime.signal])
      : this.lifetime.signal;
    this.starting ??= (async () => {
      lifetimeSignal.throwIfAborted();
      this.installation = await findInstallation(this.app);
      lifetimeSignal.throwIfAborted();
      this.root = await mkdtemp(path.join(tmpdir(), "mac-computer-use-"));
      const codexHome = path.join(this.root, "codex");
      const cwd = path.join(this.root, "workspace");
      await mkdir(codexHome, { mode: 0o700 });
      await mkdir(cwd, { mode: 0o700 });
      // The native client locates its runtime relative to CODEX_HOME. Link only the
      // verified app, never the user's configuration, permissions, or credentials.
      const componentDir = path.join(codexHome, "computer-use");
      await mkdir(componentDir, { mode: 0o700 });
      await symlink(
        this.installation.runtime,
        path.join(componentDir, "Codex Computer Use.app"),
        "dir",
      );
      await writeFile(
        path.join(codexHome, "config.toml"),
        launchConfig(this.installation.client, cwd),
        { mode: 0o600 },
      );
      lifetimeSignal.throwIfAborted();
      this.rpc = new AppServerRpc(
        this.installation.codex,
        ["app-server", "--listen", "stdio://"],
        cwd,
        brokerEnvironment(this.root, codexHome, this.installation.codex),
      );
      await this.rpc.request(
        "initialize",
        {
          clientInfo: { name: "mac_computer_use_mcp", version: "0.3.0" },
          capabilities: { experimentalApi: true },
        },
        lifetimeSignal,
        30_000,
      );
      const started = threadSchema.parse(
        await this.rpc.request(
          "thread/start",
          {
            cwd,
            ephemeral: true,
            approvalPolicy: "on-request",
            approvalsReviewer: "user",
            sandbox: "read-only",
          },
          lifetimeSignal,
          30_000,
        ),
      );
      this.threadId = started.thread.id;
    })();
    await this.starting;
  }

  async tools(signal?: AbortSignal): Promise<Tool[]> {
    await this.start(signal);
    if (this.catalog) return this.catalog;
    // Thread MCP startup is asynchronous. Bound discovery instead of silently returning an empty catalog.
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      let cursor: string | undefined;
      do {
        const page = statusSchema.parse(
          await this.rpc!.request(
            "mcpServerStatus/list",
            {
              threadId: this.threadId,
              detail: "toolsAndAuthOnly",
              limit: 100,
              ...(cursor ? { cursor } : {}),
            },
            signal,
            30_000,
          ),
        );
        const server = page.data.find((item) => item.name === "computer-use");
        if (server?.toolsError)
          throw new Error(
            `Computer Use discovery failed: ${server.toolsError}`,
          );
        if (server && Object.keys(server.tools).length) {
          this.catalog = Object.values(server.tools);
          return this.catalog;
        }
        cursor = page.nextCursor ?? undefined;
      } while (cursor && Date.now() < deadline);
      await delay(250, undefined, { signal });
    }
    throw new Error("Computer Use tools were not ready within 30 seconds");
  }

  async call(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    elicitation?: Elicitation,
  ): Promise<CallToolResult> {
    await this.start(signal);
    this.rpc!.elicitation = elicitation;
    try {
      const result = await this.rpc!.request(
        "mcpServer/tool/call",
        {
          threadId: this.threadId,
          server: "computer-use",
          tool: name,
          arguments: args,
        },
        signal,
      );
      return CallToolResultSchema.parse(result);
    } catch (error) {
      await this.close();
      throw error;
    } finally {
      if (this.rpc) this.rpc.elicitation = undefined;
    }
  }

  async close(): Promise<void> {
    this.lifetime.abort();
    await this.starting?.catch(() => {});
    await this.rpc?.close();
    if (this.root) await rm(this.root, { recursive: true, force: true });
    this.rpc = undefined;
    this.root = undefined;
    this.threadId = undefined;
    this.catalog = undefined;
    this.starting = undefined;
  }
}
