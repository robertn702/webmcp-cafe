import {
  executeApiTool,
  executeDomTool,
  requiredEngineLevel,
  supportsPackageEngine,
} from "@webmcp-today/engine";
import { ENGINE_VERSION } from "@webmcp-today/schema";
import type { PageLoadPackages } from "./local-lookup.js";
import type { McpResult, ModelContextLike } from "./model-context.js";
import type { PageStatus } from "./status.js";

type ToolExecute = (params: Record<string, unknown>) => Promise<McpResult>;

/** Seams the content script fills in; tests pass fakes. */
export interface RegistrationDeps {
  /** Installed packages matching the URL, or the reason nothing may register. */
  loadPackages: (url: string) => Promise<PageLoadPackages>;
  /** The WebMCP context to register into — the content script always supplies
   * one (native API or the built-in fallback), so this is never absent. */
  getModelContext: () => ModelContextLike;
  /** The live page document; DOM tools must never receive a detached snapshot. */
  getDocument: () => Document;
  /** Tool names the site declared itself (`form[toolname]`) — ours yield to them. */
  siteDeclaredToolNames: () => Set<string>;
  /** Surfaces the pass outcome on the action badge + popup. */
  reportStatus: (status: PageStatus) => void;
}

/**
 * One registration pass for `url`. Every tool is registered with `signal`, so
 * aborting it (on the next navigation) unregisters everything this pass added.
 *
 * Packages are looked up *before* WebMCP is probed on purpose: a missing
 * `document.modelContext` is only worth telling the user about on a page we
 * actually have tools for — probing first would warn on every page on the
 * internet.
 */
export async function runRegistrationPass(
  url: string,
  signal: AbortSignal,
  deps: RegistrationDeps,
): Promise<void> {
  const { packages, blocked } = await deps.loadPackages(url);
  // Navigated away while the lookup was in flight — the newer pass owns the
  // status, so say nothing.
  if (signal.aborted) return;

  if (blocked === "lookup-failed") {
    // A transiently unavailable service worker cannot authoritatively say the
    // page has no packages. Preserve any prior good tab status instead.
    return;
  }

  if (blocked !== undefined) {
    deps.reportStatus({
      kind: blocked === "no-revocation-list" ? "safety-list-missing" : "storage-unreadable",
    });
    return;
  }

  if (packages.length === 0) {
    deps.reportStatus({ kind: "no-packages" });
    return;
  }

  const mc = deps.getModelContext();

  const declarativeNames = deps.siteDeclaredToolNames();
  const registered: string[] = [];
  const seen = new Set<string>();

  for (const pkg of packages) {
    // Refuse the whole package when it needs an engine newer than this build — a
    // too-new package must not silently register inert/mis-executed tools.
    if (!supportsPackageEngine(pkg)) {
      console.warn(
        `[webmcp-today] Skipping package "${pkg.title}" — needs engine level ${requiredEngineLevel(pkg)}, but this extension is level ${ENGINE_VERSION}. Update the extension.`,
      );
      continue;
    }

    for (const tool of pkg.tools) {
      const execution = tool.execution;
      if (!execution) continue;

      let execute: ToolExecute;
      if (execution.mode === "api") {
        const api = pkg.api;
        const endpoint = api?.endpoints[execution.endpoint];
        if (!api || !endpoint) {
          console.warn(
            `[webmcp-today] Skipping tool "${tool.name}" — api endpoint "${execution.endpoint}" is missing from the package's api block.`,
          );
          continue;
        }
        execute = (params) => executeApiTool({ ...tool, execution }, api, params);
      } else {
        execute = (params) =>
          executeDomTool({ ...tool, execution }, params, {
            document: deps.getDocument(),
            registrationUrl: url,
            signal,
          });
      }

      if (seen.has(tool.name)) continue;
      if (declarativeNames.has(tool.name)) {
        console.warn(
          `[webmcp-today] Skipping tool "${tool.name}" — collides with a site-declared tool`,
        );
        continue;
      }
      seen.add(tool.name);

      if (signal.aborted) return;
      try {
        // Promise-based in the 2026 draft; rejects on duplicate names, which
        // also covers collisions with imperatively site-registered tools.
        // `signal` ties the tool's lifetime to this pass.
        await mc.registerTool(
          {
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
            ...(tool.annotations ? { annotations: tool.annotations } : {}),
            execute,
          },
          { signal },
        );
        registered.push(tool.name);
        console.info(`[webmcp-today] Registered tool "${tool.name}"`);
      } catch (err) {
        // `Permissions-Policy: tools=()` throws SecurityError — the SITE
        // blocks WebMCP, so retrying the remaining tools is pointless and the
        // status must not read as "package broken".
        if (err instanceof DOMException && err.name === "SecurityError") {
          console.warn(
            `[webmcp-today] This site blocks WebMCP (Permissions-Policy: tools=()) — no tools can be registered here.`,
          );
          deps.reportStatus({ kind: "site-blocked", packageCount: packages.length });
          return;
        }
        console.warn(
          `[webmcp-today] Skipping tool "${tool.name}" — registerTool rejected (name collision with a site-registered tool?):`,
          err,
        );
      }
    }
  }

  deps.reportStatus({ kind: "registered", toolNames: registered });
}
