import { describe, expect, it } from "vitest";
import {
  createPackageSchema,
  executionDescriptorSchema,
  publishVersionSchema,
  publishVersionSchemaForDomain,
  webMcpPackageSchema,
} from "../src/index.js";

const domTool = {
  name: "checkout_status",
  description: "Check whether checkout is ready.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true, untrustedContentHint: true },
  execution: {
    mode: "dom",
    observations: {
      pay_button: { role: "button", name: "Pay now", read: "disabled" },
      terms: { role: "checkbox", name: "Accept terms", read: "checked" },
    },
  },
};

function domPackage() {
  return {
    version: 1,
    domain: "en.wikipedia.org",
    urlPatterns: ["*://en.wikipedia.org/*"],
    title: "Checkout status",
    description: "Read-only checkout structure.",
    minEngine: 2,
    tools: [structuredClone(domTool)],
    api: { baseUrl: "https://en.wikipedia.org", endpoints: {} },
  };
}

describe("DOM execution descriptor", () => {
  it("accepts bounded semantic observations and an inert api block", () => {
    expect(executionDescriptorSchema.safeParse(domTool.execution).success).toBe(true);
    expect(createPackageSchema.safeParse(domPackage()).success).toBe(true);
  });

  it("requires normalized exact names and valid role/read combinations", () => {
    const decomposed = structuredClone(domTool.execution);
    decomposed.observations.pay_button.name = "Pay  now";
    expect(executionDescriptorSchema.safeParse(decomposed).success).toBe(false);

    const invalidRead = structuredClone(domTool.execution);
    invalidRead.observations.pay_button.read = "checked";
    expect(executionDescriptorSchema.safeParse(invalidRead).success).toBe(false);

    const overBytes = structuredClone(domTool.execution);
    overBytes.observations.pay_button.name = "界".repeat(200);
    expect(executionDescriptorSchema.safeParse(overBytes).success).toBe(false);

    const withinBytes = structuredClone(domTool.execution);
    withinBytes.observations.pay_button.name = "é".repeat(200);
    expect(executionDescriptorSchema.safeParse(withinBytes).success).toBe(true);
  });

  it("rejects mutation vocabulary and selectors in strict descriptors", () => {
    expect(
      executionDescriptorSchema.safeParse({ ...domTool.execution, action: "click" }).success,
    ).toBe(false);
    expect(
      executionDescriptorSchema.safeParse({ ...domTool.execution, selector: "button" }).success,
    ).toBe(false);
    expect(
      executionDescriptorSchema.safeParse({ ...domTool.execution, value: "secret" }).success,
    ).toBe(false);
    expect(
      executionDescriptorSchema.safeParse({ ...domTool.execution, submit: true }).success,
    ).toBe(false);
  });

  it("requires empty read-only, untrusted DOM tool inputs and engine level 2", () => {
    const nonEmptyInput = {
      ...domPackage(),
      tools: [
        {
          ...structuredClone(domTool),
          inputSchema: {
            type: "object",
            properties: { submit: { type: "string" } },
            additionalProperties: false,
          },
        },
      ],
    };
    expect(createPackageSchema.safeParse(nonEmptyInput).success).toBe(false);

    const destructive = {
      ...domPackage(),
      tools: [
        {
          ...structuredClone(domTool),
          annotations: { ...domTool.annotations, destructiveHint: true },
        },
      ],
    };
    expect(createPackageSchema.safeParse(destructive).success).toBe(false);

    const oldEngine = domPackage();
    oldEngine.minEngine = 1;
    expect(createPackageSchema.safeParse(oldEngine).success).toBe(false);
  });

  it("continues to reject API tools with a missing endpoint", () => {
    const invalid = {
      ...domPackage(),
      tools: [
        {
          ...structuredClone(domTool),
          execution: { mode: "api", endpoint: "missing" },
        },
      ],
    };
    expect(createPackageSchema.safeParse(invalid).success).toBe(false);
  });

  it("enforces the DOM engine floor across every package envelope", () => {
    const body = domPackage();
    body.minEngine = 1;
    expect(createPackageSchema.safeParse(body).success).toBe(false);
    const version = {
      version: body.version,
      urlPatterns: body.urlPatterns,
      tools: body.tools,
      api: body.api,
      minEngine: body.minEngine,
    };
    expect(publishVersionSchema.safeParse(version).success).toBe(false);
    expect(publishVersionSchemaForDomain(body.domain).safeParse(version).success).toBe(false);
    expect(
      webMcpPackageSchema.safeParse({
        ...body,
        id: "pkg-dom",
        versionId: "ver-dom",
        contributor: "fixture",
        createdAt: "2026-09-02T00:00:00.000Z",
        updatedAt: "2026-09-02T00:00:00.000Z",
      }).success,
    ).toBe(false);
  });
});
