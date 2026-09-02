# AGENTS.md — apps/extension

Extension-specific notes. Repo-wide guidance: root `AGENTS.md` (read it first).
Internal architecture map (the three processes, the five flows every `src/lib/` file
serves, where to look when something breaks): `apps/extension/ARCHITECTURE.md`.

## Dev browser

- `bun run dev` launches a **separate** Chrome with its own persistent profile
  (`.wxt/chrome-profile/`, gitignored). WebMCP features are force-enabled via
  `chromiumArgs` (`--enable-features=WebMCP,WebMCPTesting`)
  — `chrome://flags` will still show "Default"; `chrome://version` → Command Line
  is ground truth.
- Ports: registry web app 3000 and WXT dev server 5173. The local bridge uses
  `runtime.connectNative()` to `today.webmcp.bridge`, then a user-only Unix
  socket to the local MCP process. It calls `document.modelContext.getTools()` /
  `executeTool()` in the selected tab's content script. It never needs
  `chrome.debugger`, CDP, `tabs`, `cookies`, or arbitrary page execution.
  `packages/mcp/README.md` documents the development native-host manifest.
- The Model Context Tool Inspector must be installed manually **once** in the dev
  browser (profile persists). `--load-extension` is dead in branded Chrome 137+.

## Development extension key (stable ID for the install bridge)

The registry site reaches the extension by ID (`externally_connectable` +
`NEXT_PUBLIC_WEBMCP_EXTENSION_IDS`). Local builds use the committed development
**public** key by default, so their unpacked extension ID is stable and no local
`.env` setup is required. The corresponding private key must never be committed
or copied into an environment file.

`WXT_EXTENSION_KEY` overrides the default only when a distinct build identity
is needed. Release CI uses it for the separate release key. Changing the
development key would change the local extension ID and require updating the
native host and registry bridge allowlist.

## Self-hosted GitHub releases

`.github/workflows/release-extension.yml` builds and publishes the ZIP; CI
uploads an unsigned ZIP artifact per commit for eyeballing a build only.

- Cut a release: bump `apps/extension/package.json` version, merge, then
  `git tag extension-v<version> && git push origin extension-v<version>`.
  The workflow fails if the tag and package version disagree, re-runs
  typecheck/lint/test (a tag can come off any commit), and attaches the ZIP
  plus `SHA256SUMS`. The checksum file verifies downloaded bytes only: because
  the same workflow uploads it, it is not a detached signature or independent
  proof of publisher identity. `workflow_dispatch` with an existing tag re-runs
  it.
- **Release keypair != dev keypair.** The base64 public release key is the repo
  **variable** `WXT_EXTENSION_KEY` (a variable, not a secret: it ships inside
  `manifest.json`). Its resulting extension ID must be included in the deployed
  `NEXT_PUBLIC_WEBMCP_EXTENSION_IDS` or install buttons report the extension
  absent. Changing the key changes the ID and orphans every existing install.
- The workflow hard-fails when the variable is unset rather than shipping an
  unpinned build: without a manifest `key` an unpacked extension's ID derives
  from its directory path, so every user gets a different ID and the install
  bridge never answers.
- Off-store distribution is ZIP + **Load unpacked** only. Branded Chrome
  refuses `.crx` sideloads outside enterprise policy, so there are no
  auto-updates — users re-download, and Chrome nags about developer-mode
  extensions each launch.
- The passive update notice checks `GET /api/extension/latest` once per day and
  only appears for the known release ID when Chrome reports `installType:
"development"`. It never downloads or replaces extension files, must not alter
  badges or revocation state, and must not add permissions.

## Gotchas (hard-won 2026-07-23)

- **One dev instance only.** A second `bun run dev` crashes on the Chrome profile
  lock ("CDP connection closed before response to Extensions.loadUnpacked"), and
  interleaved runs corrupt `.output/` (manifest CSP pinned to a port the live
  server isn't on — extension loads but nothing works). Find strays with
  `lsof -nP -i :3000 -i :5173`; killing the bun wrapper does NOT kill
  the node child.
- **Page loads never hit the network.** The background resolves every URL from
  `chrome.storage.local` (install index + bodies); the registry is only polled
  for revocations. Ground truth is the **page-console** line
  `[webmcp-today] N installed package(s) matched this URL`. With an empty store
  every page logs `0 installed package(s)` and registers nothing — that is the
  expected state, not a failure. An actual failure is the warn
  `Lookup failed — the extension background did not answer`.
  To exercise a match without the registry UI, seed `chrome.storage.local`
  from the service-worker console using the keys in `src/lib/store-schema.ts`
  (`schemaVersion`, `index`, `pkg:<id>`, and `revoked` — the last one is
  mandatory: its absence is the fail-closed gate and pages then report
  "paused, waiting on the safety list" instead of matching). Set `schemaVersion`
  to the current `STORAGE_SCHEMA_VERSION` (`src/lib/store-schema.ts`), not a
  hardcoded number — a stale value reads as "older" and `initialize()` wipes
  every `pkg:*` body plus the index on the next worker wake before anything
  seeded can be exercised.
- **Isolated-world blind spot.** A content script cannot see the page's
  `history.pushState` — patching `history` only intercepts the isolated world's
  own calls, so SPA navigation is detected by polling `location.href`
  (`src/lib/navigation.ts`). Don't "fix" it by monkey-patching history.
- **Open-tab installs are live.** The content script listens for local `index`
  and `revoked` storage changes and forces a same-URL registration pass. Installing,
  uninstalling, or revoking a matching package must update an already-open tab
  without a refresh; `src/lib/navigation.ts` preserves serialized passes and aborts
  the previous pass's tools first.

## E2E testing

- Drive the dev browser's page tools through `packages/mcp` after registering
  the local native host (`packages/mcp/README.md`):
  `list_connected_webmcp_tabs` → `list_webmcp_tools` →
  `execute_webmcp_tool`. The built-in fallback registers tools without the
  WebMCP testing flag, so that flag is only needed for Chrome's native agent.
- All extension logging (match counts, registered/skipped tools, executor
  failures) lands in the **page console** — not the service worker, not the
  WXT terminal.
- Registry-unreachable signal: a `!` badge plus the popup's "Packages paused —
  waiting on the safety list" means no revocation poll has ever succeeded
  (fail-closed: installed packages stay dormant until `GET /api/revocations`
  succeeds once). Pages in that state report `safety-list-missing` and register
  nothing.
- `destructiveHint` tools gate on a blocking `window.confirm`. When the local bridge invokes one,
  the user approves the page-level confirmation manually in the selected tab. An
  `execution-timeout` means the outcome is uncertain, so verify its effect before retrying;
  `dispatch-failed` confirms it did not run and may be retried.

## Structure

- `src/entrypoints/background.ts` — resolves page-load lookups from LOCAL
  storage (`src/lib/local-lookup.ts` over the install index) and polls
  `GET /api/revocations` on a 6h `chrome.alarms` tick + startup/popup-open from
  `WXT_REGISTRY_API_URL` (default `https://webmcp.today`; polls only — page
  loads never fetch). Everything crossing a boundary is zod-validated.
- `src/lib/local-bridge-content.ts` owns live `getTools()` handles for one
  document. Only serializable descriptors leave the content script; execution
  re-resolves the tool and requires matching document + tool-list generations,
  so navigation and `toolchange` fail stale calls rather than calling a new page.
  `local-bridge-router.ts` enumerates package-matched tabs and lets the native
  bridge focus one before targeting the user's selected visible tab;
  `native-bridge.ts` reconnects the ephemeral MV3 worker without retaining
  request state.
- The install bridge: `externally_connectable` (built from
  `src/lib/registry-origins.ts`'s `registryMatchPatterns()` — the same function
  the runtime origin allowlist derives from; dev builds also trust
  `http://localhost/*`, production builds only `https://webmcp.today/*`) lets
  ONLY the registry site reach
  `runtime.onMessageExternal`. `src/lib/install-bridge.ts` handles
  ping/install/uninstall/list-installs (protocol:
  `packages/schema/src/bridge.ts` — both sides validate against it; never
  redeclare the shapes). Install fetches the version body from the SENDER's
  origin, validates it against `webMcpPackageSchema` (structural + cross-field,
  including domain scope — `invalid-body` refusal on failure), bootstraps the
  revocation list on first install (`revocation-unavailable` refusal if that
  fetch fails — nothing is written), and writes body+index in one atomic set.
  Site side:
  `apps/web/lib/extension-bridge.ts` (probes `NEXT_PUBLIC_WEBMCP_EXTENSION_IDS`)
  - `apps/web/components/install-button.tsx`.
- E2E for the install path (replaces "did the registry fetch work"): `bun run
dev` + web on :3000 → open `/packages/<id>` → install → popup lists it →
  navigate to the target site → page console shows `[webmcp-today] 1 installed
package(s) matched this URL` → bridge `list_webmcp_tools` shows the tools.
- Storage lives in `chrome.storage.local` under a small set of keys
  (`src/lib/store-schema.ts`): a schema version, an install index with per-package
  bodies, the revoked kill list + cursor, and the discovery domain list.
  Read/write goes through `src/lib/installs-store.ts` over an injected
  `StorageArea` seam (`src/lib/storage.ts`); tests use
  `test/fake-storage-area.ts`, never `fakeBrowser`/`wxt/browser`.
- `src/lib/register-tools.ts` — one registration pass (package lookup → WebMCP
  probe → registerTool), taking its side effects as injected deps so it is
  unit-testable; the content script supplies the real ones. A
  `Permissions-Policy: tools=()` page throws `SecurityError` at registerTool —
  reported as the distinct `site-blocked` status, not "package broken".
- `src/entrypoints/popup/` + the action badge — per-tab status, the install
  list (with uninstall), and the paused/recovery states. Never inject UI into
  the page.
- The executors live in `packages/engine` (`@webmcp-today/engine`, MIT) —
  extracted from `src/lib/` for license separation (docs/DECISIONS.md 2026-07-30):
  `api-executor.ts` binds `{{param}}` templates, acquires auth
  tokens from `api.auth` sources, performs the origin-pinned fetch, checks
  `errorPath`, applies the `returns` JMESPath projection. The sole cross-origin
  exception is anonymous `GET` reads from `https://hacker-news.firebaseio.com`,
  with no auth, omitted cookies, and rejected redirects. `destructiveHint`
  tools gate on a blocking `window.confirm`. The fetch MUST run in the
  content-script (page) context — the SameSite-cookie rationale is the header
  comment in `packages/engine/src/api-executor.ts`. `dom-executor.ts` is a separate
  level-2, read-only semantic observer; registration passes it the live document, URL,
  and abort signal so navigation and frames fail closed.
- The bundled fallback is gone: the `@webmcp-today/curated-packages` dependency was
  removed in step 5b (U7). The package remains the seed source for the registry
  (`apps/web/scripts/seed.ts`).
- `public/THIRD-PARTY-LICENSES.md` ships verbatim in the packaged bundle and
  lists the deps the build inlines (currently zod + the MPL-2.0 jmespath).
  Update it whenever bundled dependencies change — including if a tree-shaken
  dep ever starts reaching `.output/`.
