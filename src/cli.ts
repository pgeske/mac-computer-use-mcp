#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CodexBackend } from "./backend.js";
import { findInstallation } from "./installation.js";
import { parseOptions } from "./options.js";
import { createServer } from "./server.js";

const args = process.argv.slice(2);
const help = `mac-computer-use-mcp — OpenAI's Mac tools for any MCP harness

Usage: mac-computer-use-mcp [options]
       mac-computer-use-mcp --doctor [--app /Applications/ChatGPT.app]

  --app PATH             Official ChatGPT.app or Codex.app (auto-detected)
  --trust-app BUNDLE_ID   Preauthorize one exact app; repeat for more apps
  --read-only            Reject clicks, typing, and other UI mutations
  --idle-seconds N       Release the backend after inactivity (10–3600; default 300)
  --doctor               Verify installed binaries; does not access app contents
  --help                 Show help

Without --trust-app, enabling a session requires interactive MCP form approval.
One approval covers apps until stop, idle expiry, error, or reconnect.
macOS Accessibility/Screen Recording permissions are still required.
This bridge does not run a model and is not an OS security sandbox.
`;

try {
  if (args.includes("--help")) console.log(help);
  else if (args.includes("--doctor")) {
    const options = parseOptions(args.filter((arg) => arg !== "--doctor"));
    const installed = await findInstallation(options.app);
    console.log(
      JSON.stringify(
        {
          verified: true,
          app: installed.app,
          version: installed.version,
          desktopAccessTested: false,
        },
        null,
        2,
      ),
    );
  } else {
    const options = parseOptions(args);
    const backend = new CodexBackend(options.app);
    const server = createServer(backend, options);
    let shuttingDown = false;
    const shutdown = async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      const deadline = setTimeout(() => process.exit(1), 10_000);
      try {
        await backend.close();
        await server.close();
      } finally {
        clearTimeout(deadline);
      }
    };
    process.once("SIGINT", () => {
      void shutdown();
    });
    process.once("SIGTERM", () => {
      void shutdown();
    });
    process.stdin.once("end", () => {
      void shutdown();
    });
    await server.connect(new StdioServerTransport());
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "Computer Use failed");
  process.exitCode = 1;
}
