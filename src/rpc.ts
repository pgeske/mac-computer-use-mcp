import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { groupExists, ownedGroups, signalGroups } from "./processes.js";

export type RpcMethod =
  | "initialize"
  | "thread/start"
  | "mcpServerStatus/list"
  | "mcpServer/tool/call";
const methods = new Set<string>([
  "initialize",
  "thread/start",
  "mcpServerStatus/list",
  "mcpServer/tool/call",
]);
const maxMessageBytes = 32 * 1024 * 1024;

type Pending = { resolve(value: unknown): void; reject(error: Error): void };
export type Elicitation = (params: unknown) => Promise<unknown>;

// Only this transport can write to app-server: there is no generic agent-facing RPC tool.
export class AppServerRpc {
  private child: ChildProcessWithoutNullStreams;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private buffer = "";
  private failure?: Error;
  private stopping?: Promise<void>;
  private exited: Promise<void>;
  private unexpectedExit = false;
  elicitation?: Elicitation;

  constructor(
    command: string,
    args: string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
  ) {
    this.child = spawn(command, args, {
      cwd,
      env,
      stdio: "pipe",
      detached: true,
      shell: false,
    });
    this.exited = new Promise((resolve) => this.child.once("close", resolve));
    this.child.once("error", () =>
      this.fail(new Error("Could not start app-server")),
    );
    this.child.once("close", () => {
      if (!this.stopping) this.unexpectedExit = true;
      this.fail(
        new Error(
          "App-server disconnected; inspect the app installation and macOS permissions",
        ),
      );
    });
    this.child.stdin.on("error", () =>
      this.fail(new Error("App-server input closed")),
    );
    // Drain stderr, but never persist backend logs or potentially private app content.
    this.child.stderr.resume();
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      try {
        this.buffer += chunk;
        if (Buffer.byteLength(this.buffer) > maxMessageBytes)
          throw new Error("App-server output exceeded the message limit");
        let newline: number;
        while ((newline = this.buffer.indexOf("\n")) !== -1) {
          const line = this.buffer.slice(0, newline);
          this.buffer = this.buffer.slice(newline + 1);
          if (line.trim()) this.receive(JSON.parse(line));
        }
      } catch (error) {
        this.fail(
          error instanceof Error
            ? error
            : new Error("Invalid app-server output"),
        );
      }
    });
  }

  private send(message: object): void {
    if (this.failure) throw this.failure;
    if (!this.child.stdin.writable)
      throw new Error("App-server input is unavailable");
    this.child.stdin.write(JSON.stringify(message) + "\n");
  }

  private receive(raw: unknown): void {
    if (!raw || typeof raw !== "object")
      throw new Error("Invalid app-server message");
    const message = raw as Record<string, unknown>;
    if (typeof message.method === "string") {
      if (
        message.method.startsWith("turn/") ||
        message.method.startsWith("item/")
      ) {
        throw new Error("Unexpected model activity: stopping Computer Use");
      }
      if (message.id !== undefined) {
        if (message.method !== "mcpServer/elicitation/request") {
          this.send({
            id: message.id,
            error: {
              code: -32601,
              message: "This bridge only handles MCP elicitation",
            },
          });
          return;
        }
        const handler = this.elicitation;
        void (async () => {
          let result: unknown = { action: "cancel" };
          try {
            if (handler) result = await handler(message.params);
          } catch {
            /* Deny on unavailable/failed host UI. */
          }
          if (!this.failure && !this.stopping)
            this.send({ id: message.id, result });
        })().catch(() =>
          this.fail(new Error("Failed to answer app-server elicitation")),
        );
      }
      return;
    }
    const pending = this.pending.get(Number(message.id));
    if (!pending) return;
    this.pending.delete(Number(message.id));
    if (message.error) {
      const error = message.error as { message?: string };
      pending.reject(new Error(error.message ?? "App-server request failed"));
    } else pending.resolve(message.result);
  }

  private fail(error: Error): void {
    this.failure ??= error;
    for (const pending of this.pending.values()) pending.reject(this.failure);
    this.pending.clear();
    void this.close().catch(() => {});
  }

  async request(
    method: RpcMethod,
    params: object,
    signal?: AbortSignal,
    timeoutMs = 120_000,
  ): Promise<unknown> {
    if (!methods.has(method))
      throw new Error("App-server method is not allowed");
    signal?.throwIfAborted();
    if (this.failure) throw this.failure;
    const id = this.nextId++;
    const abort = () =>
      this.fail(
        new Error(
          "Computer Use cancelled; no action will be retried automatically",
        ),
      );
    const timeout = setTimeout(
      () =>
        this.fail(
          new Error(
            `${method} timed out; the outcome may be uncertain. Inspect before retrying.`,
          ),
        ),
      timeoutMs,
    );
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const result = await new Promise<unknown>((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        try {
          this.send({ id, method, params });
        } catch (error) {
          this.pending.delete(id);
          reject(error);
        }
      });
      if (this.failure) throw this.failure;
      if (method === "initialize") this.send({ method: "initialized" });
      return result;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    }
  }

  close(): Promise<void> {
    this.stopping ??= (async () => {
      this.failure ??= new Error("Computer Use session ended");
      for (const pending of this.pending.values()) pending.reject(this.failure);
      this.pending.clear();
      const pid = this.child.pid;
      try {
        const groups = pid
          ? [...new Set([pid, ...(await ownedGroups(pid))])]
          : [];
        // EOF invokes app-server's orderly thread/MCP cleanup. Its native MCP child has
        // a separate process group, so killing only the outer app-server is insufficient.
        this.child.stdin.end();
        await Promise.race([this.exited, delay(3000)]);
        const forced = groups.some(groupExists);
        if (forced) {
          signalGroups(groups, "SIGTERM");
          await delay(500);
          signalGroups(groups, "SIGKILL");
        }
        const deadline = Date.now() + 1000;
        while (groups.some(groupExists) && Date.now() < deadline)
          await delay(25);
        if (groups.some(groupExists) || this.unexpectedExit || forced)
          throw new Error(
            "Backend cleanup could not be fully verified after an exit or forced termination. Private state was retained; inspect owned processes before reconnecting.",
          );
      } finally {
        this.child.stdout.destroy();
        this.child.stderr.destroy();
        this.child.stdin.destroy();
      }
    })();
    return this.stopping;
  }
}
