import { defineContentScript } from "wxt/utils/define-content-script";
import { browser } from "wxt/browser";
import { getPackagesForUrl } from "../lib/packages.js";
import {
  getModelContext,
  getToolConsumerModelContext,
  type ModelContextLike,
  type ToolConsumerModelContextLike,
} from "../lib/model-context.js";
import { getOrCreateFallbackModelContext } from "../lib/model-context-fallback.js";
import { startNavigationWatcher } from "../lib/navigation.js";
import { runRegistrationPass, type RegistrationDeps } from "../lib/register-tools.js";
import { STATUS_MESSAGE_TYPE, type PageStatus } from "../lib/status.js";
import { LocalBridgeContent } from "../lib/local-bridge-content.js";
import { contentBridgeRequestSchema } from "@webmcp-today/schema";
import { INDEX_KEY, REVOKED_KEY } from "../lib/store-schema.js";

export default defineContentScript({
  matches: ["<all_urls>"],
  runAt: "document_idle",
  main() {
    const localBridge = new LocalBridgeContent({
      getConsumer: getContentModelContext,
      getTitle: () => document.title,
      getUrl: () => window.location.href,
    });
    localBridge.installToolChangeListener();
    browser.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
      if (!contentBridgeRequestSchema.safeParse(message).success) return;
      void localBridge.handleMessage(message).then(sendResponse);
      return true;
    });

    // Runs the first pass now and re-runs it on SPA route changes or local
    // install/safety changes, so an already-open tab does not need a refresh.
    startNavigationWatcher({
      getUrl: () => window.location.href,
      run: (url, signal) => {
        localBridge.invalidateDocument();
        return runRegistrationPass(url, signal, deps);
      },
      subscribeInvalidation(invalidate) {
        const listener: Parameters<typeof browser.storage.onChanged.addListener>[0] = (
          changes,
          areaName,
        ) => {
          if (
            areaName === "local" &&
            (changes[INDEX_KEY] !== undefined || changes[REVOKED_KEY] !== undefined)
          ) {
            invalidate();
          }
        };
        browser.storage.onChanged.addListener(listener);
        return () => browser.storage.onChanged.removeListener(listener);
      },
    });
  },
});

const deps: RegistrationDeps = {
  loadPackages: getPackagesForUrl,
  getModelContext: getContentModelContext,
  getDocument: () => document,
  siteDeclaredToolNames,
  reportStatus,
};

let contentModelContext: (ModelContextLike & ToolConsumerModelContextLike) | undefined;
let didLogFallback = false;

function getContentModelContext(): ModelContextLike & ToolConsumerModelContextLike {
  if (contentModelContext) return contentModelContext;

  const provider = getModelContext();
  const consumer = getToolConsumerModelContext();
  if (isCompleteModelContext(provider, consumer)) {
    contentModelContext = provider;
    return contentModelContext;
  }
  if (!didLogFallback) {
    console.info(
      "[webmcp-today] WebMCP native API absent — using built-in fallback; tools available via the WebMCP Today bridge only",
    );
    didLogFallback = true;
  }
  contentModelContext = getOrCreateFallbackModelContext();
  return contentModelContext;
}

function isCompleteModelContext(
  provider: ModelContextLike | undefined,
  consumer: ToolConsumerModelContextLike | undefined,
): provider is ModelContextLike & ToolConsumerModelContextLike {
  return provider !== undefined && consumer !== undefined && Object.is(provider, consumer);
}

/** Tools the site declared itself — ours skip on a name collision. */
function siteDeclaredToolNames(): Set<string> {
  const names = new Set<string>();
  for (const form of document.querySelectorAll("form[toolname]")) {
    const name = form.getAttribute("toolname");
    if (name) names.add(name);
  }
  return names;
}

/** Fire-and-forget: nothing here should fail a registration pass. */
function reportStatus(status: PageStatus): void {
  void browser.runtime
    .sendMessage({ type: STATUS_MESSAGE_TYPE, status, hostname: window.location.hostname })
    .catch(() => {});
}
