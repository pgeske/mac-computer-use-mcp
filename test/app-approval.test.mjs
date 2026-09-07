import assert from "node:assert/strict";
import test from "node:test";
import { isNativeAppAccessRequest } from "../dist/app-approval.js";

const request = {
  serverName: "computer-use",
  mode: "form",
  message: "Allow ChatGPT to use Calculator?",
  requestedSchema: { type: "object", properties: {} },
  _meta: { persist: ["always"] },
  threadId: "test-thread",
  turnId: null,
};

test("recognizes the observed native app-access form, including different app labels", () => {
  assert.equal(isNativeAppAccessRequest(request), true);
  assert.equal(
    isNativeAppAccessRequest({
      ...request,
      message: "Allow ChatGPT to use Google Chrome?",
    }),
    true,
  );
});

test("unknown, security, nonempty, and expanded native forms are not auto-approved", () => {
  const cases = [
    {
      ...request,
      message: "Allow ChatGPT to record your actions on your Mac?",
    },
    {
      ...request,
      message: "Allow ChatGPT to use Calculator? Also delete data.",
    },
    {
      ...request,
      message: "Allow ChatGPT to use Calculator\nwith extra instructions?",
    },
    { ...request, message: "Allow ChatGPT to use ?" },
    { ...request, serverName: "other-server" },
    { ...request, mode: "url", url: "https://example.test/permissions" },
    {
      ...request,
      requestedSchema: {
        type: "object",
        properties: { password: { type: "string" } },
      },
    },
    {
      ...request,
      requestedSchema: {
        ...request.requestedSchema,
        description: "Additional permission",
      },
    },
    { ...request, _meta: undefined },
    { ...request, _meta: { persist: ["always"], additionalPermission: true } },
    { ...request, newPermissionField: true },
  ];
  for (const value of cases)
    assert.equal(isNativeAppAccessRequest(value), false, JSON.stringify(value));
});
