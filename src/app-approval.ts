import { z } from "zod";

export const nativeHighRiskWarning =
  "Allowing ChatGPT to use this app introduces new risks, including those related to prompt injection attacks, such as data theft or loss. Carefully monitor ChatGPT while it uses this app.";

// Observed for Calculator and Chrome in signed client build 1000926. There is no
// stable app-access kind field: recognize these exact forms, not arbitrary warnings.
const appAccessRequest = z
  .object({
    serverName: z.literal("computer-use"),
    mode: z.literal("form"),
    message: z.string().regex(/^Allow ChatGPT to use [^?\x00-\x1f\x7f]+\?$/),
    requestedSchema: z
      .object({
        type: z.literal("object"),
        properties: z.object({}).strict(),
      })
      .strict(),
    _meta: z.union([
      z.object({ persist: z.tuple([z.literal("always")]) }).strict(),
      z
        .object({
          persist: z.tuple([z.literal("always")]),
          riskLevel: z.literal("high"),
          subtitle: z.literal(nativeHighRiskWarning),
        })
        .strict(),
    ]),
    threadId: z.string().optional(),
    turnId: z.string().nullable().optional(),
  })
  .strict();

export function isNativeAppAccessRequest(request: unknown): boolean {
  return appAccessRequest.safeParse(request).success;
}
