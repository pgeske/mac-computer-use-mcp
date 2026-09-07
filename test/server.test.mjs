import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createServer } from "../dist/server.js";
import { parseOptions } from "../dist/options.js";

const app = "com.apple.calculator";
const catalog = ["get_app_state", "click", "type_text"].map((name) => ({
  name,
  description: name,
  inputSchema: {
    type: "object",
    required: ["app"],
    properties: { app: { type: "string" } },
    additionalProperties: false,
  },
}));
catalog.push({ name: "list_apps", inputSchema: { type: "object" } });
catalog.push({
  name: "unexpected_future_tool",
  inputSchema: { type: "object" },
});
const state = {
  content: [
    { type: "text", text: "Calculator: 9" },
    { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
  ],
};

async function setup(t, { args = [], approval, call, tools, idleMs } = {}) {
  const calls = [];
  let closes = 0;
  let discoveries = 0;
  const backend = {
    async tools() {
      discoveries++;
      return tools ?? catalog;
    },
    async call(...parameters) {
      calls.push(parameters.slice(0, 2));
      return call ? call(...parameters) : state;
    },
    async close() {
      closes++;
    },
  };
  const options = parseOptions(args);
  if (idleMs !== undefined) options.idleMs = idleMs;
  const server = createServer(backend, options);
  const client = new Client(
    { name: "test", version: "1" },
    { capabilities: approval ? { elicitation: { form: {} } } : {} },
  );
  if (approval) client.setRequestHandler(ElicitRequestSchema, approval);
  const [host, peer] = InMemoryTransport.createLinkedPair();
  await server.connect(peer);
  await client.connect(host);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  return {
    client,
    calls,
    get closes() {
      return closes;
    },
    get discoveries() {
      return discoveries;
    },
  };
}

async function invoke(client, name, args = {}) {
  return client.callTool({ name, arguments: args });
}

test("discovery retains live schemas, excludes unknown tools, and uses conservative hints", async (t) => {
  const { client } = await setup(t);
  const result = await client.listTools();
  assert.equal(result.tools.length, 6);
  const click = result.tools.find((tool) => tool.name === "click");
  assert.deepEqual(click.inputSchema, catalog[1].inputSchema);
  assert.equal(click.annotations.destructiveHint, true);
  assert.equal(click.annotations.openWorldHint, true);
  assert.equal(
    result.tools.find((tool) => tool.name === "get_app_state").annotations
      .readOnlyHint,
    false,
  );
});

test("status does not discover or touch desktop state", async (t) => {
  const s = await setup(t);
  await invoke(s.client, "computer_use_status");
  assert.equal(s.discoveries, 0);
  assert.equal(s.calls.length, 0);
});

test("headless default fails closed; a model cannot trust an app through tool arguments", async (t) => {
  const { client, calls } = await setup(t);
  const result = await invoke(client, "get_app_state", { app });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /requires MCP form elicitation/);
  const forged = await invoke(client, "get_app_state", { app, trusted: true });
  assert.equal(forged.isError, true);
  assert.equal(calls.length, 0);
});

test("trusted exact bundle ID permits inspection and actions, forwarding images unchanged", async (t) => {
  const { client, calls } = await setup(t, { args: ["--trust-app", app] });
  assert.deepEqual(await invoke(client, "get_app_state", { app }), state);
  assert.deepEqual(await invoke(client, "click", { app }), state);
  assert.deepEqual(
    calls.map(([name]) => name),
    ["get_app_state", "click"],
  );
  assert.equal(
    (await invoke(client, "get_app_state", { app: "com.apple.TextEdit" }))
      .isError,
    true,
  );
  assert.equal(
    (
      await invoke(client, "get_app_state", {
        app: "/System/Applications/Calculator.app",
      })
    ).isError,
    true,
  );
});

test("actions require inspection in the same session and stop invalidates it", async (t) => {
  const { client, calls } = await setup(t, { args: ["--trust-app", app] });
  assert.equal((await invoke(client, "click", { app })).isError, true);
  await invoke(client, "get_app_state", { app });
  await invoke(client, "computer_use_stop");
  assert.equal((await invoke(client, "click", { app })).isError, true);
  assert.equal(calls.length, 1);
});

test("read-only rejects mutations even for a trusted app", async (t) => {
  const { client, calls } = await setup(t, {
    args: ["--read-only", "--trust-app", app],
  });
  await invoke(client, "get_app_state", { app });
  const result = await invoke(client, "click", { app });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /read-only/);
  assert.equal(calls.length, 1);
});

test("declined and cancelled approvals never dispatch", async (t) => {
  for (const action of ["decline", "cancel"]) {
    const { client, calls } = await setup(t, {
      approval: async () => ({ action }),
    });
    assert.equal(
      (await invoke(client, "get_app_state", { app })).isError,
      true,
    );
    assert.equal(calls.length, 0);
  }
});

test("one session approval covers actions, other apps, and app inventory", async (t) => {
  let approvals = 0;
  const { client } = await setup(t, {
    approval: async () => {
      approvals++;
      return { action: "accept", content: {} };
    },
  });
  await invoke(client, "get_app_state", { app });
  await invoke(client, "click", { app });
  await invoke(client, "get_app_state", { app: "com.google.Chrome" });
  await invoke(client, "click", { app: "com.google.Chrome" });
  await invoke(client, "list_apps");
  assert.equal(approvals, 1);
  const status = await invoke(client, "computer_use_status");
  assert.equal(JSON.parse(status.content[0].text).sessionApproved, true);
});

test("stop and idle expiry revoke session approval", async (t) => {
  for (const expiry of ["stop", "idle"]) {
    let approvals = 0;
    const s = await setup(t, {
      idleMs: expiry === "idle" ? 20 : undefined,
      approval: async () => {
        approvals++;
        return { action: "accept", content: {} };
      },
    });
    await invoke(s.client, "get_app_state", { app });
    if (expiry === "stop") await invoke(s.client, "computer_use_stop");
    else await new Promise((resolve) => setTimeout(resolve, 60));
    await invoke(s.client, "get_app_state", { app });
    assert.equal(approvals, 2, expiry);
  }
});

test("new connections do not inherit approval from a previous client", async (t) => {
  const first = await setup(t, {
    approval: async () => ({ action: "accept", content: {} }),
  });
  await invoke(first.client, "get_app_state", { app });
  await first.client.close();
  const second = await setup(t);
  assert.equal(
    (await invoke(second.client, "get_app_state", { app })).isError,
    true,
  );
  assert.equal(second.calls.length, 0);
});

test("backend failures revoke approval before the next attempt", async (t) => {
  let approvals = 0;
  let attempts = 0;
  const s = await setup(t, {
    approval: async () => {
      approvals++;
      return { action: "accept", content: {} };
    },
    call: async () => {
      if (++attempts === 1) throw new Error("failed");
      return state;
    },
  });
  assert.equal(
    (await invoke(s.client, "get_app_state", { app })).isError,
    true,
  );
  await invoke(s.client, "get_app_state", { app });
  assert.equal(approvals, 2);
});

test("stop during approval cannot grant a subsequent session", async (t) => {
  let release;
  let entered;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  let approvals = 0;
  const s = await setup(t, {
    approval: async () => {
      approvals++;
      if (approvals === 1) {
        entered();
        await pending;
      }
      return { action: "accept", content: {} };
    },
  });
  const first = invoke(s.client, "get_app_state", { app });
  await started;
  await invoke(s.client, "computer_use_stop");
  release();
  assert.equal((await first).isError, true);
  await invoke(s.client, "get_app_state", { app });
  assert.equal(approvals, 2);
  assert.equal(s.calls.length, 1);
});

test("session approval never automatically answers native permission requests", async (t) => {
  const messages = [];
  const s = await setup(t, {
    approval: async (request) => {
      messages.push(request.params.message);
      return messages.length === 1
        ? { action: "accept", content: {} }
        : { action: "decline" };
    },
    call: async (_name, _args, _signal, elicit) => {
      assert.deepEqual(
        await elicit({
          mode: "form",
          message: "Native permission",
          requestedSchema: { type: "object", properties: {} },
        }),
        { action: "decline" },
      );
      return state;
    },
  });
  await invoke(s.client, "get_app_state", { app });
  assert.equal(messages.length, 2);
  assert.match(messages[0], /across apps/);
  assert.equal(messages[1], "Native permission");
});

test("native elicitation is forwarded and is not implicitly approved by --trust-app", async (t) => {
  const native = {
    mode: "form",
    message: "Native permission",
    requestedSchema: { type: "object", properties: {} },
  };
  let received;
  const { client } = await setup(t, {
    args: ["--trust-app", app],
    approval: async (request) => {
      received = request.params;
      return { action: "decline" };
    },
    call: async (_name, _args, _signal, elicit) => {
      assert.deepEqual(await elicit(native), { action: "decline" });
      return state;
    },
  });
  await invoke(client, "get_app_state", { app });
  assert.deepEqual(received, native);
});

test("errors preserve uncertainty without retrying the backend", async (t) => {
  const s = await setup(t, {
    args: ["--trust-app", app],
    call: async () => {
      throw new Error("outcome uncertain");
    },
  });
  const result = await invoke(s.client, "get_app_state", { app });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /outcome uncertain/);
  assert.equal(s.calls.length, 1);
  assert.ok(s.closes > 0);
});

test("concurrent requests never interleave backend operations", async (t) => {
  let active = 0;
  let maximum = 0;
  const { client } = await setup(t, {
    args: ["--trust-app", app],
    call: async () => {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active--;
      return state;
    },
  });
  await Promise.all([
    invoke(client, "get_app_state", { app }),
    invoke(client, "get_app_state", { app }),
  ]);
  assert.equal(maximum, 1);
});

test("stop interrupts active work and invalidates queued actions without waiting for the action", async (t) => {
  let release;
  let entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const s = await setup(t, {
    args: ["--trust-app", app],
    call: async () => {
      entered();
      await pending;
      return state;
    },
  });
  const active = invoke(s.client, "get_app_state", { app });
  await started;
  const queued = invoke(s.client, "click", { app });
  const stopped = await invoke(s.client, "computer_use_stop");
  assert.equal(stopped.isError, undefined);
  assert.ok(s.closes > 0);
  release();
  assert.equal((await active).isError, true);
  assert.equal((await queued).isError, true);
  assert.equal(s.calls.length, 1);
});
