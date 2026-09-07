import { z } from "zod";

// Observed in the signed Computer Use client (build 1000926). There is no stable
// app-access kind field: require the complete known form and forward any drift.
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
    _meta: z.object({ persist: z.tuple([z.literal("always")]) }).strict(),
    threadId: z.string().optional(),
    turnId: z.string().nullable().optional(),
  })
  .strict();

export function isNativeAppAccessRequest(request: unknown): boolean {
  return appAccessRequest.safeParse(request).success;
}
