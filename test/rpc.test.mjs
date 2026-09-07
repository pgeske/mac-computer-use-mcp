import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { AppServerRpc } from "../dist/rpc.js";

async function fake(t, mode = "normal") {
  const root = await mkdtemp(path.join(tmpdir(), "mcu-rpc-test-"));
  const file = path.join(root, "server.mjs");
  await writeFile(
    file,
    `
import { createInterface } from 'node:readline';
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
const mode = ${JSON.stringify(mode)};
let pending;
createInterface({input:process.stdin}).on('line', line => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') return send({id:request.id,result:{pid:process.pid}});
  if (request.method === 'initialized') return;
  if (mode === 'model') return send({method:'turn/started',params:{}});
  if (mode === 'bad-json') return process.stdout.write('not-json\\n');
  if (mode === 'hang') return;
  if (mode === 'elicitation' && request.method) {
    pending = request.id;
    return send({id:'approval',method:'mcpServer/elicitation/request',params:{mode:'form',message:'Allow?',requestedSchema:{type:'object',properties:{}}}});
  }
  if (request.id === 'approval') return send({id:pending,result:request.result});
  send({id:request.id,result:{method:request.method}});
});
`,
  );
  const rpc = new AppServerRpc(process.execPath, [file], root, {
    PATH: process.env.PATH,
  });
  t.after(async () => {
    await rpc.close();
    await rm(root, { recursive: true, force: true });
  });
  return rpc;
}

test("RPC only permits the bridge methods and supports multiple requests", async (t) => {
  const rpc = await fake(t);
  await rpc.request("initialize", {});
  assert.deepEqual(await rpc.request("thread/start", {}), {
    method: "thread/start",
  });
  await assert.rejects(rpc.request("turn/start", {}), /not allowed/);
});

test("unexpected model activity fails closed", async (t) => {
  const rpc = await fake(t, "model");
  await rpc.request("initialize", {});
  await assert.rejects(
    rpc.request("thread/start", {}),
    /Unexpected model activity/,
  );
});

test("malformed backend output fails closed", async (t) => {
  const rpc = await fake(t, "bad-json");
  await rpc.request("initialize", {});
  await assert.rejects(rpc.request("thread/start", {}));
});

test("cancellation kills the owned process and rejects pending calls", async (t) => {
  const rpc = await fake(t, "hang");
  const { pid } = await rpc.request("initialize", {});
  const controller = new AbortController();
  const pending = rpc.request("mcpServer/tool/call", {}, controller.signal);
  controller.abort();
  await assert.rejects(pending, /cancelled/);
  await rpc.close();
  assert.throws(() => process.kill(pid, 0));
});

test("timeout does not retry an uncertain action", async (t) => {
  const rpc = await fake(t, "hang");
  await rpc.request("initialize", {});
  await assert.rejects(
    rpc.request("mcpServer/tool/call", {}, undefined, 20),
    /outcome may be uncertain/,
  );
});

test("native approval fails closed without a host handler", async (t) => {
  const rpc = await fake(t, "elicitation");
  await rpc.request("initialize", {});
  assert.deepEqual(await rpc.request("mcpServer/tool/call", {}), {
    action: "cancel",
  });
});

test("unexpected broker exit never reports verified cleanup", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "mcu-orphan-test-"));
  const file = path.join(root, "exit.mjs");
  await writeFile(
    file,
    `
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
const child = spawn('/bin/sleep', ['10'], {detached:true,stdio:'ignore'});
child.unref();
createInterface({input:process.stdin}).on('line', line => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') process.stdout.write(JSON.stringify({id:request.id,result:{child:child.pid}})+'\\n');
  else if (request.method !== 'initialized') process.exit(0);
});
`,
  );
  const rpc = new AppServerRpc(process.execPath, [file], root, {});
  const initialized = await rpc.request("initialize", {});
  t.after(async () => {
    try {
      process.kill(initialized.child, "SIGKILL");
    } catch {
      /* Already exited. */
    }
    await rpc.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  await assert.rejects(rpc.request("mcpServer/tool/call", {}), /disconnected/);
  await assert.rejects(rpc.close(), /cleanup could not be fully verified/);
});

test("native approval passes the host decision without widening it", async (t) => {
  const rpc = await fake(t, "elicitation");
  await rpc.request("initialize", {});
  rpc.elicitation = async () => ({ action: "accept", content: {} });
  assert.deepEqual(await rpc.request("mcpServer/tool/call", {}), {
    action: "accept",
    content: {},
  });
});
