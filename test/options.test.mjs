import assert from "node:assert/strict";
import test from "node:test";
import { parseOptions } from "../dist/options.js";
import { brokerEnvironment, launchConfig } from "../dist/backend.js";

test("defaults require approval and support explicit exact app trust", () => {
  assert.equal(parseOptions([]).trustedApps.size, 0);
  assert.equal(parseOptions([]).readOnly, false);
  assert.equal(
    parseOptions(["--trust-app", "com.apple.calculator"]).trustedApps.has(
      "com.apple.calculator",
    ),
    true,
  );
  for (const args of [
    ["--trust-app", "*"],
    ["--trust-app", "Calculator"],
    ["--trust-app"],
    ["--idle-seconds", "0"],
    ["--typo"],
  ]) {
    assert.throws(() => parseOptions(args));
  }
});

test("broker environment does not inherit credentials or the caller PATH", () => {
  const env = brokerEnvironment(
    "/private/session",
    "/private/session/codex",
    "/Applications/ChatGPT.app/Contents/Resources/codex",
  );
  assert.deepEqual(Object.keys(env).sort(), [
    "CODEX_HOME",
    "HOME",
    "LANG",
    "PATH",
    "TMPDIR",
  ]);
  assert.equal(env.HOME, "/private/session");
  assert.equal(
    env.PATH,
    "/Applications/ChatGPT.app/Contents/Resources:/usr/bin:/bin:/usr/sbin:/sbin",
  );
});

test("generated private config disables model transport and unrelated features", () => {
  const config = launchConfig('/signed/client"name', "/private/workspace");
  assert.match(config, /model_provider = "bridge-disabled"/);
  assert.match(config, /cli_auth_credentials_store = "file"/);
  assert.match(config, /base_url = "http:\/\/127.0.0.1:1"/);
  assert.match(config, /shell_tool = false/);
  assert.match(config, /plugins = false/);
  assert.match(config, /hooks = false/);
  assert.match(config, /client\\"name/);
});
