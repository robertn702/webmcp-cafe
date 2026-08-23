import { describe, expect, it } from "vitest";
import { MCP_BRIDGE_PACKAGE } from "@/app/(registry)/docs/content";

describe("MCP_BRIDGE_PACKAGE", () => {
  it("pins the verified published bridge version", () => {
    expect(MCP_BRIDGE_PACKAGE).toBe("@webmcp-today/mcp-bridge@0.3.0");
  });
});
