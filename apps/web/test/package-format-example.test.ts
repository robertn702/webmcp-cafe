import {
  apiEndpointSchema,
  createPackageObjectSchema,
  createPackageSchema,
  ENGINE_VERSION,
  TOOL_DESCRIPTION_MAX,
  TOOL_NAME_MAX,
} from "@webmcp-today/schema";
import { describe, expect, it } from "vitest";
import examplePackage from "@/app/(registry)/docs/package-format/example-package.json";

// The worked example on /docs/package-format is hand-written prose's one
// falsifiable claim: it says "this document validates". Parsing it here means a
// schema change breaks the build instead of quietly invalidating what the page
// tells publishers. Same trick packages/curated-packages/src/index.ts uses on
// the real packages.
describe("docs package-format example", () => {
  it("validates against createPackageSchema", () => {
    const parsed = createPackageSchema.safeParse(examplePackage);
    expect(parsed.error?.issues ?? []).toEqual([]);
    expect(parsed.success).toBe(true);
  });

  it("demonstrates the parts the page documents", () => {
    const parsed = createPackageSchema.parse(examplePackage);
    // A read tool and a write tool, the write one behind an auth source — the
    // shape the page's surrounding paragraph describes.
    expect(parsed.tools.length).toBeGreaterThanOrEqual(2);
    expect(parsed.api.auth).toBeDefined();
    for (const tool of parsed.tools) {
      expect(tool.execution?.mode).toBe("api");
    }
  });

  // The page cites these budgets by number (tool name ≤30, tool description
  // ≤500, engine level 2). If any of them move, /docs/package-format needs a
  // matching edit — this assertion is what forces that instead of silent rot.
  it("cites the budget constants the page states", () => {
    expect(TOOL_NAME_MAX).toBe(30);
    expect(TOOL_DESCRIPTION_MAX).toBe(500);
    expect(ENGINE_VERSION).toBe(2);
  });

  // The page's "The shape" section documents every top-level field by name.
  // Adding or removing one here must fail this test, not just silently
  // desync the prose.
  it("documents the exact set of top-level fields", () => {
    expect(Object.keys(createPackageObjectSchema.shape).sort()).toEqual(
      [
        "version",
        "domain",
        "urlPatterns",
        "title",
        "description",
        "tools",
        "api",
        "minEngine",
        "changelog",
      ].sort(),
    );
  });

  // Same guarantee for "An endpoint". apiEndpointSchema is wrapped in a
  // superRefine, so .shape is only reachable via the inner ZodObject.
  it("documents the exact set of endpoint fields", () => {
    expect(Object.keys(apiEndpointSchema.shape).sort()).toEqual(
      [
        "method",
        "baseUrl",
        "path",
        "query",
        "body",
        "form",
        "returns",
        "errorPath",
        "stripPrefix",
        "graphql",
        "auth",
      ].sort(),
    );
  });
});
