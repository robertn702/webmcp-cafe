import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseHTML } from "linkedom";
import { webMcpPackageSchema, type WebMcpPackage } from "@webmcp-today/schema";
import type { PageLoadPackages } from "../src/lib/local-lookup.js";
import type { ModelContextLike } from "../src/lib/model-context.js";
import { getOrCreateFallbackModelContext } from "../src/lib/model-context-fallback.js";
import { runRegistrationPass, type RegistrationDeps } from "../src/lib/register-tools.js";
import type { PageStatus } from "../src/lib/status.js";

const PAGE_URL = "https://en.wikipedia.org/wiki/Coffee";

function pkg(...toolNames: string[]): WebMcpPackage {
  return webMcpPackageSchema.parse({
    id: "pkg-wiki",
    versionId: "ver-1",
    version: 1,
    contributor: "robert",
    createdAt: "2026-07-27T00:00:00.000Z",
    updatedAt: "2026-07-27T00:00:00.000Z",
    domain: "en.wikipedia.org",
    urlPatterns: ["*://en.wikipedia.org/wiki/*"],
    title: "Wikipedia article",
    description: "Fixture package",
    minEngine: 1,
    tools: toolNames.map((name) => ({
      name,
      description: `${name} fixture tool`,
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true },
      execution: { mode: "api", endpoint: "summary" },
    })),
    api: {
      baseUrl: "https://en.wikipedia.org",
      endpoints: { summary: { method: "GET", path: "/api/summary" } },
    },
  });
}

function domPkg(): WebMcpPackage {
  return webMcpPackageSchema.parse({
    id: "pkg-dom",
    versionId: "ver-dom",
    version: 1,
    contributor: "robert",
    createdAt: "2026-09-02T00:00:00.000Z",
    updatedAt: "2026-09-02T00:00:00.000Z",
    domain: "en.wikipedia.org",
    urlPatterns: ["*://en.wikipedia.org/wiki/*"],
    title: "DOM fixture",
    description: "Read-only DOM fixture package",
    minEngine: 2,
    tools: [
      {
        name: "wiki_dom_status",
        description: "Read page heading status.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true, untrustedContentHint: true },
        execution: {
          mode: "dom",
          observations: { heading: { role: "heading", name: "Coffee", read: "exists" } },
        },
      },
    ],
    api: { baseUrl: "https://en.wikipedia.org", endpoints: {} },
  });
}

/** Records what was registered; `reject` names make registerTool fail. */
function recordingContext(reject: string[] = []): {
  mc: ModelContextLike;
  registered: string[];
  signals: Array<AbortSignal | undefined>;
} {
  const registered: string[] = [];
  const signals: Array<AbortSignal | undefined> = [];
  const mc: ModelContextLike = {
    registerTool: async (descriptor, options) => {
      if (reject.includes(descriptor.name)) throw new Error("duplicate tool name");
      registered.push(descriptor.name);
      signals.push(options?.signal);
    },
  };
  return { mc, registered, signals };
}

function harness(
  load: WebMcpPackage[] | PageLoadPackages,
  mc: ModelContextLike,
  declared: string[] = [],
): { deps: RegistrationDeps; statuses: PageStatus[]; getModelContext: () => unknown } {
  const result: PageLoadPackages = Array.isArray(load) ? { packages: load } : load;
  const statuses: PageStatus[] = [];
  const getModelContext = vi.fn(() => mc);
  const deps: RegistrationDeps = {
    loadPackages: vi.fn(async () => result),
    getModelContext,
    getDocument: () => document,
    siteDeclaredToolNames: () => new Set(declared),
    reportStatus: (status) => {
      statuses.push(status);
    },
  };
  return { deps, statuses, getModelContext };
}

describe("runRegistrationPass", () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("stays silent on a page with no matching packages, without probing WebMCP", async () => {
    const { deps, statuses, getModelContext } = harness([], recordingContext().mc);

    await runRegistrationPass(PAGE_URL, new AbortController().signal, deps);

    expect(statuses).toEqual([{ kind: "no-packages" }]);
    // Order matters: probing first would warn about the flag on every page.
    expect(getModelContext).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("registers matching tools and reports their names", async () => {
    const { mc, registered } = recordingContext();
    const { deps, statuses } = harness([pkg("wiki_summary", "wiki_search")], mc);

    await runRegistrationPass(PAGE_URL, new AbortController().signal, deps);

    expect(registered).toEqual(["wiki_summary", "wiki_search"]);
    expect(statuses).toEqual([{ kind: "registered", toolNames: ["wiki_summary", "wiki_search"] }]);
  });

  it("dispatches DOM tools against the live document and fails stale or aborted calls", async () => {
    const { document: liveDocument, window } = parseHTML(
      "<!doctype html><html><body><h1>Coffee</h1></body></html>",
    );
    Object.defineProperty(window, "location", { configurable: true, value: { href: PAGE_URL } });
    Object.defineProperty(window, "top", { configurable: true, value: window });
    Object.defineProperty(window, "parent", { configurable: true, value: window });
    vi.stubGlobal("document", liveDocument);
    vi.stubGlobal("Element", window.Element);
    vi.stubGlobal("HTMLInputElement", window.HTMLInputElement);
    vi.stubGlobal("HTMLTextAreaElement", window.HTMLTextAreaElement);
    let execute: ((params: Record<string, unknown>) => Promise<unknown>) | undefined;
    const mc: ModelContextLike = {
      registerTool: async (descriptor) => {
        execute = descriptor.execute;
      },
    };
    const { deps, statuses } = harness([domPkg()], mc);
    deps.getDocument = () => liveDocument;
    const controller = new AbortController();

    await runRegistrationPass(PAGE_URL, controller.signal, deps);

    expect(statuses).toEqual([{ kind: "registered", toolNames: ["wiki_dom_status"] }]);
    if (execute === undefined) throw new Error("DOM fixture was not registered");
    await expect(execute({})).resolves.toEqual({
      content: [{ type: "text", text: '{"heading":{"matched":true}}' }],
    });
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { href: "https://en.wikipedia.org/wiki/Tea" },
    });
    await expect(execute({})).resolves.toEqual({
      content: [{ type: "text", text: "DOM tool execution failed." }],
    });
    controller.abort();
    await expect(execute({})).resolves.toEqual({
      content: [{ type: "text", text: "DOM tool execution failed." }],
    });
  });

  it("registers tools through the in-memory fallback", async () => {
    vi.stubGlobal("document", {});
    vi.stubGlobal("location", { origin: "https://en.wikipedia.org" });
    const { deps, statuses } = harness([pkg("wiki_fallback")], getOrCreateFallbackModelContext());
    const controller = new AbortController();

    await runRegistrationPass(PAGE_URL, controller.signal, deps);

    expect(statuses).toEqual([{ kind: "registered", toolNames: ["wiki_fallback"] }]);
    controller.abort();
  });

  it("skips tools that collide with a site-declared tool", async () => {
    const { mc, registered } = recordingContext();
    const { deps, statuses } = harness([pkg("wiki_summary", "wiki_search")], mc, ["wiki_search"]);

    await runRegistrationPass(PAGE_URL, new AbortController().signal, deps);

    expect(registered).toEqual(["wiki_summary"]);
    expect(statuses).toEqual([{ kind: "registered", toolNames: ["wiki_summary"] }]);
  });

  it("registers every tool with the pass signal, so navigation can drop them", async () => {
    const { mc, signals } = recordingContext();
    const { deps } = harness([pkg("wiki_summary", "wiki_search")], mc);
    const controller = new AbortController();

    await runRegistrationPass(PAGE_URL, controller.signal, deps);

    expect(signals).toEqual([controller.signal, controller.signal]);
  });

  it("registers nothing and reports nothing when the pass is aborted mid-lookup", async () => {
    const { mc, registered } = recordingContext();
    const controller = new AbortController();
    const statuses: PageStatus[] = [];
    const deps: RegistrationDeps = {
      loadPackages: async () => {
        controller.abort();
        return { packages: [pkg("wiki_summary")] };
      },
      getModelContext: () => mc,
      getDocument: () => document,
      siteDeclaredToolNames: () => new Set(),
      reportStatus: (status) => statuses.push(status),
    };

    await runRegistrationPass(PAGE_URL, controller.signal, deps);

    expect(registered).toEqual([]);
    // The pass that superseded this one owns the badge.
    expect(statuses).toEqual([]);
  });

  it("stops registering as soon as the signal aborts mid-pass", async () => {
    const controller = new AbortController();
    const registered: string[] = [];
    const mc: ModelContextLike = {
      registerTool: async (descriptor) => {
        registered.push(descriptor.name);
        controller.abort();
      },
    };
    const { deps, statuses } = harness([pkg("wiki_summary", "wiki_search")], mc);

    await runRegistrationPass(PAGE_URL, controller.signal, deps);

    expect(registered).toEqual(["wiki_summary"]);
    expect(statuses).toEqual([]);
  });

  it("keeps going when registerTool rejects, and leaves the tool out of the status", async () => {
    const { mc, registered } = recordingContext(["wiki_summary"]);
    const { deps, statuses } = harness([pkg("wiki_summary", "wiki_search")], mc);

    await runRegistrationPass(PAGE_URL, new AbortController().signal, deps);

    expect(registered).toEqual(["wiki_search"]);
    expect(statuses).toEqual([{ kind: "registered", toolNames: ["wiki_search"] }]);
  });

  it("registers nothing and reports site-blocked when the site forbids WebMCP (SecurityError)", async () => {
    const registered: string[] = [];
    const mc: ModelContextLike = {
      registerTool: async () => {
        // What Chrome throws on a Permissions-Policy: tools=() page.
        throw new DOMException(
          "WebMCP is disallowed by Permissions-Policy on this page",
          "SecurityError",
        );
      },
    };
    const { deps, statuses } = harness([pkg("wiki_summary", "wiki_search")], mc);

    await runRegistrationPass(PAGE_URL, new AbortController().signal, deps);

    expect(registered).toEqual([]);
    expect(statuses).toEqual([{ kind: "site-blocked", packageCount: 1 }]);
  });

  it("treats other registerTool errors as per-tool skips, not site-blocked", async () => {
    const registered: string[] = [];
    const mc: ModelContextLike = {
      registerTool: async (descriptor) => {
        if (descriptor.name === "wiki_summary") {
          throw new DOMException("quota exceeded", "QuotaExceededError");
        }
        registered.push(descriptor.name);
      },
    };
    const { deps, statuses } = harness([pkg("wiki_summary", "wiki_search")], mc);

    await runRegistrationPass(PAGE_URL, new AbortController().signal, deps);

    expect(registered).toEqual(["wiki_search"]);
    expect(statuses).toEqual([{ kind: "registered", toolNames: ["wiki_search"] }]);
  });

  it("reports safety-list-missing when the fail-closed gate blocks the pass", async () => {
    const { deps, statuses, getModelContext } = harness(
      { packages: [], blocked: "no-revocation-list" },
      recordingContext().mc,
    );

    await runRegistrationPass(PAGE_URL, new AbortController().signal, deps);

    expect(statuses).toEqual([{ kind: "safety-list-missing" }]);
    expect(getModelContext).not.toHaveBeenCalled();
  });

  it("reports storage-unreadable when storage was written by a newer build", async () => {
    const { deps, statuses } = harness(
      { packages: [], blocked: "storage-unreadable" },
      recordingContext().mc,
    );

    await runRegistrationPass(PAGE_URL, new AbortController().signal, deps);

    expect(statuses).toEqual([{ kind: "storage-unreadable" }]);
  });

  it("preserves the prior status when the background lookup fails", async () => {
    const { deps, statuses, getModelContext } = harness(
      { packages: [], blocked: "lookup-failed" },
      recordingContext().mc,
    );

    await runRegistrationPass(PAGE_URL, new AbortController().signal, deps);

    expect(statuses).toEqual([]);
    expect(getModelContext).not.toHaveBeenCalled();
  });
});
