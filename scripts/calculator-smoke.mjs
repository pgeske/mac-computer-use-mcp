import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";

if (process.env.MAC_COMPUTER_USE_LIVE !== "1") {
  throw new Error(
    "Set MAC_COMPUTER_USE_LIVE=1 to explicitly allow this test to operate Calculator",
  );
}
const client = new Client(
  { name: "calculator-smoke", version: "0.1.0" },
  { capabilities: { elicitation: { form: {} } } },
);
let approvalRequests = 0;
client.setRequestHandler(ElicitRequestSchema, async (request) => {
  approvalRequests++;
  // The opt-in test only operates Calculator, plus optional read-only Chrome inspection.
  // Any extra prompt fails the test rather than hiding an approval regression.
  if (
    approvalRequests === 1 &&
    request.params.mode === "form" &&
    request.params.message.startsWith(
      "Enable computer use for this session across apps?",
    ) &&
    Object.keys(request.params.requestedSchema.properties).length === 0
  ) {
    console.log(
      "Approving one computer-use connection for the scoped smoke test",
    );
    return { action: "accept", content: {} };
  }
  return { action: "cancel" };
});
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [new URL("../dist/cli.js", import.meta.url).pathname],
  stderr: "inherit",
});
const app = "com.apple.calculator";
async function call(name, args) {
  const result = await client.callTool({ name, arguments: args }, undefined, {
    timeout: 120_000,
  });
  const text = result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  assert.notEqual(result.isError, true, text);
  return { result, text };
}
try {
  await client.connect(transport);
  const catalog = await client.listTools();
  console.log(`Discovered ${catalog.tools.length} tools through standard MCP`);
  const before = await call("get_app_state", { app });
  console.log("Calculator initial state:", before.text);
  await call("press_key", { app, key: "Escape" });
  await call("type_text", { app, text: "4+5" });
  await call("press_key", { app, key: "Return" });
  const after = await call("get_app_state", { app });
  console.log("Calculator result:", after.text);
  assert.match(
    after.text.replace(/[\u200e\u200f\u2066-\u2069]/g, ""),
    /\btext 9(?:\s|$)/,
  );
  assert.ok(
    after.result.content.some((block) => block.type === "image"),
    "Expected a native MCP screenshot",
  );
  await call("computer_use_stop", {});

  // A second task must reacquire the native backend without asking for consent again.
  if (process.env.MAC_COMPUTER_USE_CHROME === "1") {
    // Do not print or save the current browser's private app state/screenshot.
    const chrome = await call("get_app_state", { app: "com.google.Chrome" });
    assert.ok(chrome.result.content.some((block) => block.type === "image"));
    console.log("Read-only Chrome inspection succeeded after Calculator stop");
    await call("computer_use_stop", {});
  }
  await call("get_app_state", { app });
  await call("computer_use_stop", {});
  assert.equal(
    approvalRequests,
    1,
    "Expected one connection approval across tasks",
  );
  const status = await call("computer_use_status", {});
  assert.equal(JSON.parse(status.text).sessionApproved, true);
  await call("computer_use_revoke", {});
  const revoked = await call("computer_use_status", {});
  assert.equal(JSON.parse(revoked.text).sessionApproved, false);
  console.log(
    "PASS: task boundaries preserve one approval; explicit revoke clears it",
  );
} finally {
  await client.close();
}
