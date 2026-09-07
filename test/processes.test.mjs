import assert from "node:assert/strict";
import test from "node:test";
import { descendantGroups } from "../dist/processes.js";

test("cleanup includes separately grouped descendants, not siblings or the shared service", () => {
  const snapshot = `
    100 1 100
    101 100 100
    102 100 102
    103 102 103
    200 1 200
    201 1 201
    300 1 300
  `;
  assert.deepEqual(descendantGroups(snapshot, 100).sort(), [100, 102, 103]);
});

test("cleanup never adopts an external process group", () => {
  assert.deepEqual(
    descendantGroups("100 1 100\n101 100 99\n99 1 99", 100),
    [100],
  );
});
