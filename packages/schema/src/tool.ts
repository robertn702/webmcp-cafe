import { z } from "zod";
import { TOOL_DESCRIPTION_MAX, TOOL_NAME_MAX } from "./budgets.js";
import { executionDescriptorSchema } from "./execution.js";
import { inputSchemaSchema } from "./input-schema.js";

// Tool descriptor — one WebMCP tool: metadata + its execution binding.

export const toolAnnotationsSchema = z
  .strictObject({
    readOnlyHint: z.boolean().optional(),
    untrustedContentHint: z.boolean().optional(),
    destructiveHint: z.boolean().optional(),
  })
  .superRefine((annotations, ctx) => {
    if (annotations.readOnlyHint === true && annotations.destructiveHint === true) {
      ctx.addIssue({
        code: "custom",
        message: "A read-only tool cannot also be destructive",
        path: ["destructiveHint"],
      });
    }
  });

const toolDescriptorObjectSchema = z.strictObject({
  name: z
    .string()
    .min(1)
    .max(TOOL_NAME_MAX)
    .regex(/^[A-Za-z][A-Za-z0-9_-]*$/, "must start with a letter; letters/digits/_/- only"),
  description: z.string().min(1).max(TOOL_DESCRIPTION_MAX),
  inputSchema: inputSchemaSchema,
  annotations: toolAnnotationsSchema.optional(),
  // API references are package-level (they need the sibling `api` block) —
  // see collectApiIssues in api.ts. DOM tools are constrained below.
  execution: executionDescriptorSchema,
});

export const toolDescriptorSchema = toolDescriptorObjectSchema.superRefine((tool, ctx) => {
  if (tool.execution.mode !== "dom") return;

  if (
    Object.keys(tool.inputSchema.properties).length > 0 ||
    (tool.inputSchema.required?.length ?? 0) > 0
  ) {
    ctx.addIssue({
      code: "custom",
      message: "DOM tools must use an empty input schema",
      path: ["inputSchema"],
    });
  }
  if (tool.annotations?.readOnlyHint !== true) {
    ctx.addIssue({
      code: "custom",
      message: "DOM tools must set annotations.readOnlyHint to true",
      path: ["annotations", "readOnlyHint"],
    });
  }
  if (tool.annotations?.untrustedContentHint !== true) {
    ctx.addIssue({
      code: "custom",
      message: "DOM tools must set annotations.untrustedContentHint to true",
      path: ["annotations", "untrustedContentHint"],
    });
  }
  if (tool.annotations?.destructiveHint === true) {
    ctx.addIssue({
      code: "custom",
      message: "DOM tools cannot be destructive",
      path: ["annotations", "destructiveHint"],
    });
  }
});

export type ToolAnnotations = z.infer<typeof toolAnnotationsSchema>;
export type ToolDescriptor = z.infer<typeof toolDescriptorSchema>;
