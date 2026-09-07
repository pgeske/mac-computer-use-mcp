import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const exec = promisify(execFile);

test("CLI help works without an OpenAI app and invalid flags fail", async () => {
  const { stdout } = await exec(process.execPath, ["dist/cli.js", "--help"]);
  assert.match(stdout, /MCP form approval/);
  await assert.rejects(
    exec(process.execPath, ["dist/cli.js", "--trust-app", "*"]),
    /exact bundle identifier/,
  );
});

test("release tarball contains compiled runtime but no tests, secrets, or dependencies", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "mcu-package-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { stdout } = await exec("npm", [
    "pack",
    "--ignore-scripts",
    "--json",
    "--pack-destination",
    root,
  ]);
  const [report] = JSON.parse(stdout);
  const files = report.files.map((file) => file.path);
  for (const required of [
    "dist/cli.js",
    "dist/backend.js",
    "dist/rpc.js",
    "dist/server.js",
    "README.md",
    "SECURITY.md",
    "LICENSE",
  ]) {
    assert.ok(files.includes(required), `Missing ${required}`);
  }
  assert.equal(
    files.some(
      (file) => /^(test|src|node_modules)\//.test(file) || file === ".env",
    ),
    false,
  );
});
