import { z } from "zod";

const DOM_NAME_BYTES_MAX = 512;

function utf8LengthAtMost(value: string, limit: number): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else bytes += 3;
    } else bytes += 3;
    if (bytes > limit) return limit + 1;
  }
  return bytes;
}

// Execution descriptors bind a tool either to an API endpoint or to a tightly
// constrained read-only DOM observation set. API reference integrity remains
// package-level because it needs the sibling `api` block.

export const apiExecutionSchema = z.strictObject({
  mode: z.literal("api"),
  endpoint: z.string().min(1).max(64),
});

const normalizedName = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => value === value.normalize("NFC").replace(/\s+/gu, " ").trim(), {
    message: "must use NFC normalization with collapsed whitespace",
  })
  .refine((value) => utf8LengthAtMost(value, DOM_NAME_BYTES_MAX) <= DOM_NAME_BYTES_MAX, {
    message: "must not exceed 512 UTF-8 bytes",
  });

const domRoleSchema = z.enum(["button", "checkbox", "group", "heading", "link", "textbox"]);
const domReadSchema = z.enum(["exists", "disabled", "checked", "required"]);

export const domObservationSchema = z
  .strictObject({
    role: domRoleSchema,
    name: normalizedName,
    read: domReadSchema,
  })
  .superRefine((observation, ctx) => {
    const valid =
      observation.read === "exists" ||
      (observation.read === "checked" && observation.role === "checkbox") ||
      (observation.read === "required" && ["checkbox", "textbox"].includes(observation.role)) ||
      (observation.read === "disabled" &&
        ["button", "checkbox", "textbox"].includes(observation.role));
    if (!valid) {
      ctx.addIssue({
        code: "custom",
        message: `read "${observation.read}" is not supported for role "${observation.role}"`,
        path: ["read"],
      });
    }
  });

export const domExecutionSchema = z.strictObject({
  mode: z.literal("dom"),
  observations: z
    .record(
      z
        .string()
        .min(1)
        .max(32)
        .regex(/^[A-Za-z][A-Za-z0-9_-]*$/, "must be an identifier-shaped key"),
      domObservationSchema,
    )
    .refine(
      (observations) => Object.keys(observations).length >= 1,
      "must declare at least one observation",
    )
    .refine(
      (observations) => Object.keys(observations).length <= 16,
      "may declare at most 16 observations",
    ),
});

export const executionDescriptorSchema = z.discriminatedUnion("mode", [
  apiExecutionSchema,
  domExecutionSchema,
]);

export type ApiExecution = z.infer<typeof apiExecutionSchema>;
export type DomExecution = z.infer<typeof domExecutionSchema>;
export type DomObservation = z.infer<typeof domObservationSchema>;
export type ExecutionDescriptor = z.infer<typeof executionDescriptorSchema>;
