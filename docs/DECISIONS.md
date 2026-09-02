# DECISIONS.md — WebMCP Today

Why the non-obvious calls were made, so they don't get relitigated or quietly undone.
Inclusion bar and entry format: root `AGENTS.md` → "Decision log". This is deliberately
**not** a changelog or a complete history — entries are pruned once their reasoning
lives in code or another doc, and **code + `AGENTS.md` win on disagreement**.

- 2026-08-09 — **Only the Hacker News Firebase origin may be used as a cross-origin
  `api.baseUrl` override, and only for anonymous public GETs.** Hacker News's official
  read API lives at Firebase rather than the visible `news.ycombinator.com` origin.
  Rejected: a package-wide extra-origin allowlist, which would duplicate endpoint
  declarations without adding a security boundary. The exception is fixed to
  `https://hacker-news.firebaseio.com`: no writes, no auth sources, cookies omitted,
  and redirects rejected; credentials and authenticated actions remain pinned to the
  package's primary origin.

- 2026-08-07 — **An agent with local socket access may focus any tab matching an
  installed package, replacing the manual-focus consent gate.** Focusing raises the
  tab and its window, preserving the user-sees-what's-driven property while making
  target selection agent-callable. Rejected: adding the `tabs` permission —
  `tabs.update` needs none and `<all_urls>` content-script matches already expose
  `tab.url`, while the permission adds a “read your browsing history” install warning;
  and OS-level AppleScript focus — outside the extension trust model and
  permission-fragile.

- 2026-07-28 — **DOM mode is a narrow read-only observation capability, not browser
  automation.** Some sites have no usable API for non-sensitive structure, so level 2
  admits exact semantic role/name observations only. It rejects selectors, values, raw
  HTML, frames, shadow roots, and mutations; bounded traversal/name work and ambiguous
  matches fail closed. Rejected: restoring click/type/form choreography or generic DOM
  extraction — both reintroduce silent selector rot and sensitive-data exposure. API
  execution remains the preferred general mode; DOM-only packages retain an inert API
  block to avoid persistence migration scope.

- 2026-07-23 — **Registry lookups are fetched in the extension's background worker, not
  the content script.** A background fetch goes to the registry's own origin and is not
  subject to the page's CSP; `host_permissions` does _not_ override a page's
  `connect-src`, so a content-script fetch would break on any strict-CSP site. The
  content script asks via `browser.runtime.sendMessage`. Don't move it back for
  simplicity — the indirection is the point.

- 2026-07-23 — **Dark mode is semantic-token-driven: no `dark:` variants outside
  `components/ui/`.** Pages use `bg-background` / `text-muted-foreground` /
  `border-border` and shadcn's `.dark` block remaps those tokens. Two shadcn workarounds
  exist solely to satisfy the repo's no-`as` rule and look deletable but aren't:
  `apps/web/types/react-css-properties.d.ts` restores the custom-property index
  signature on `React.CSSProperties` (`--gap` etc.), and Badge/Button carry
  `"use client"` because their `Slot` import from the unified `radix-ui` package runs
  `createContext` at module scope, which the App Router rejects in Server Components.

- 2026-07-24 — **Per-tool verification was replaced by the package-install model.**
  Dropped `configs` / `tools` / `verification_snapshots` / `votes` and the `yolo` param
  in favour of `packages` / `package_versions` (append-only) / `installs`.
  A reviewer gate on individual tools scales with the corpus and stalls publishing; the
  unit of trust is a package a user chose to install. Open-publish for tier 1 follows
  from this — a review queue is a tier-2/3 problem (`docs/BACKLOG.md`).

- 2026-07-24 — **better-auth-ui components are vendored with ~30 upstream `as`
  assertions rewritten to narrowing** — `e.currentTarget` locals, `formString` in
  `apps/web/lib/form-data.ts`, `Reflect.get`, type predicates, and the
  `AdditionalFieldRegister` render augmentation in
  `apps/web/components/auth/auth-provider.tsx`. The repo's no-`as` lint rule doesn't
  permit the upstream shape, so **expect conflicts on every shadcn-registry re-sync**:
  re-apply the narrowings rather than reintroducing casts.
  `organization-api-keys.tsx` is deliberately not vendored (no org plugin server-side).

- 2026-07-24 — **`minEngine` is a positive-integer capability level, and it lives on
  `package_versions`, not `packages`.** The format has no patch releases,
  so semver's extra dimensions were meaningless — it's compared with plain `>=` against
  `ENGINE_VERSION` (`packages/schema/src/budgets.ts`). Version-scoped because an engine
  requirement is a property of a version's _content_, so a user pinned to an older
  version must never be blocked by a newer version's requirement.

- 2026-07-24 — **No tool-output character cap in v1.** The executors used to truncate
  every result to 1.5K (`TOOL_OUTPUT_MAX`), which silently clipped read tools mid-JSON.
  Chrome's 1.5K is guidance, not enforcement, and the right budget is model-dependent
  (a 1M-context model should be far less conservative than a 256K one), so a single
  hard cap was the wrong default. Publish-time metadata caps (name 30, tool description
  500, param description 150) are untouched and stay hard. The `returns` projection is
  still valuable for output density, just not for fitting a fixed budget. The budget
  question is **deferred, not answered** (`docs/BACKLOG.md`).

- 2026-08-06 — **The built-in fallback removed the WebMCP-flag requirement; the flag is only
  needed for Chrome's native agent.** No origin-trial path exists for injected tools — we
  inject into third-party sites, which never serve a trial token on our behalf — so the
  native API stays flag-gated through Chrome 156. The extension originally detected a missing
  `modelContext` and walked the user through `chrome://flags/#enable-webmcp-testing`; the
  document-local polyfill (`apps/extension/src/lib/model-context-fallback.ts`) made that
  obsolete: tools register and stay reachable through the WebMCP Today bridge with no flag at
  all. Launch to developers stands — the reachable audience is people willing to run a Chrome
  flag — as does the wire-compatible Hub `GET /api/packages/lookup` distribution fallback
  (`docs/BACKLOG.md`).

- 2026-07-24 — **Flag-missing and SPA-navigation handling: four calls that look
  arbitrary from the code.** (1) Packages are looked up _before_ `getModelContext()` is
  probed — the other order can't distinguish "the flag is off" from "nothing to inject
  here", and warning on the probe alone would fire on every page on the internet. (2)
  The signal goes to the extension's own surfaces (popup, action badge, page-console
  warn), never an injected page banner — user-hostile and a CWS-review risk. (3)
  Per-tab status is an in-memory Map in the background worker; a restart loses it and
  the popup then says "reload the page", which is cheaper than paying for the `storage`
  permission. (4) One `AbortController` per registration pass, aborted on the next URL
  change, so a route's tools die with the pass that made them; passes are serialized,
  unchanged URL events are no-ops, and install/revocation storage changes explicitly
  force a same-URL pass so already-open tabs update without a refresh. SPA detection
  lives in the content script partly to
  avoid `chrome.webNavigation`'s "read your browsing history" store warning — see
  `apps/extension/AGENTS.md` for why its 500 ms poll can't be replaced.

- 2026-07-25 — **Split license: AGPL-3.0-only server, MIT adoption surface.** Root
  `LICENSE` (AGPL) scopes to `apps/web` + `packages/db`; `packages/schema`,
  `packages/mcp`, `packages/curated-packages` and `apps/extension` each ship their own MIT
  `LICENSE`. Start open, but keep the option to sell a hosted server later. The Joakim
  Selemyr attribution block therefore lives only where the ported MIT code actually is
  (`packages/schema/LICENSE`, `apps/extension/LICENSE`). `CONTRIBUTING.md` carries a
  CLA granting an irrevocable relicensing right rather than copyright assignment, so
  contributors keep their copyright and the relicensing option survives without chasing
  them. Git history was deliberately not rewritten — the MIT-era commits are inert
  because the repo was never distributed.

- 2026-07-25 — **Installed packages move into the extension's `chrome.storage.local`;
  no account needed to consume, auth only to publish.** Design:
  `docs/local-first-installs.md` (**decided; steps 1–6 implemented, step 7 pending**).
  What forced it: the extension sends every URL it sees to
  `GET /api/packages/lookup`, so the registry receives a browsing-history feed, and the
  lookup's default branch serves latest-version packages to anyone — meaning **install
  has never affected what registers**. Consequences worth knowing without opening the
  doc: the auto-registering bundled fallback becomes a first-run _suggestion_ list; a
  revocation feed is **mandatory**, because once bodies live on disk it is the
  registry's only remaining lever; install count is dropped as a trust signal
  (anonymous consumption makes it inflatable, and no code path ever ranked by it).
  Supersedes the older credentialed-`installed=true` plan, which kept the URL feed and
  made consumption require an account — the opposite of the direction chosen.

- 2026-07-25 — **Submitted packages are covered by `/terms`, not a per-package license
  field.** The inbound grant is irrevocable, which is load-bearing: versions are
  append-only and installs pin, so a revoked grant would break live installs. The
  corpus goes out under CC0 because MIT's notice-retention clause is unworkable on a
  JSON blob injected into a live page and would be decorative (`packages/curated-packages`
  stays MIT — it's code-shaped and ships its own LICENSE). Deliberately not done: a
  `license` field on `packages/schema`, and a required `agreeToTerms` field — that
  would break the seed corpus and every published consumer.

- 2026-07-26 — **`revocations.id` is a `bigserial`, not the repo's usual random uuid.**
  It doubles as the client's poll cursor (`GET /api/revocations?since=`,
  `WHERE id > cursor`), and a random uuid isn't monotonic, so it can't mean "everything
  I haven't seen". Knock-ons: `?since=` and `revocationEntrySchema.id` are numbers
  rather than uuid strings, and the feed is served **ascending** so a capped page is a
  contiguous prefix of the unseen tail instead of a newest-first slice that would
  strand entries behind an advanced cursor.

- 2026-07-26 — **A client must complete one successful revocation poll before any
  package becomes registerable** — fail-closed on first run.
  `docs/local-first-installs.md` §5's fail-safe ("a failed poll leaves the last known
  list in place") silently assumes a previous list exists; on a fresh client "fetch
  failed" and "fetched, zero revocations" are indistinguishable, so as written it
  registers everything — backwards for exactly the case revocation exists to cover.
  A package can only enter storage via a successful registry fetch, so requiring the
  first revocation fetch on that same path makes "has packages but never polled"
  unreachable, and every later poll keeps the friendly fail-safe: stale but
  restrictive, never re-enabling. Precedent: OCSP soft-fail versus Chrome's CRLSets —
  OCSP's flaw wasn't the concept but failing open under a network condition the
  attacker controls. **Recorded now, implemented at step 4.**

- 2026-07-26 — **`packages.tags` dropped.** Nothing read it: no query
  filtered, sorted or searched on it, no UI rendered it, the extension never looked at
  it. Discovery is domain + urlPattern matching; ranking is install count + pattern
  specificity. Re-addable later if a browse facet needs one — a nullable jsonb column
  costs nothing to re-add, and the format is easier to widen than to narrow.

- 2026-07-26 — **better-auth's tables live in an `auth` Postgres schema, not `public`.**
  `public` was never chosen — it's drizzle's default and no schema was ever named. The
  motive is a grant boundary around the only credential material in the database
  (`accounts.access_token`/`refresh_token`, `api_keys.key`): one
  `REVOKE ... ON SCHEMA auth` covers them, where per-table grants silently miss whatever
  table is added next. Explicitly _not_ the Supabase/Neon Auth rationale — there the
  namespace is owned by another party, which doesn't apply to a library whose migrations
  we write. Deferred on purpose: the restricted role that would use the boundary doesn't
  exist yet, so this buys the option, not the protection. Non-obvious consequence:
  `drizzle.config.ts` must set `schemaFilter: ["public", "auth"]` — it defaults to
  `["public"]`, and introspect/push would otherwise propose dropping the auth set.

- 2026-07-26 — **The entity is `package` everywhere — DB, API, schema, and UI copy
  collapse to one name.** `configs` was rejected as too generic (every app has
  "config"); `definitions` was rejected as DB jargon that shouldn't leak past
  `packages/db`; `scripts` was rejected because it contradicts the "packages are data,
  not code" claim the Chrome Web Store positioning rests on
  (`docs/api-execution-model.md`). Done now, pre-publish, because neither
  `@robertn702/webmcp-today-schema` nor `@robertn702/webmcp-today-mcp` is on npm yet — the
  MCP tool names and wire fields are free to rename without breaking a saved agent
  prompt, which won't be true again.

- 2026-07-27 — **The `api` block is our own format, not OpenAPI or Arazzo.** OpenAPI
  describes a call _space_; the block prescribes _one call_ bound to a validated
  `inputSchema`, and under 3.1 that binding layer is 100% `x-*` extensions — a document
  no OpenAPI tool can execute, checked by a validator that ignores every field that
  matters. Sharper: tier 1 calls a site's first-party frontend with the user's cookies,
  while published specs describe the public API on another host with token auth, so the
  two sets barely intersect — causally, not by sampling. Arazzo's semantics fit but it
  `MUST` carry a `sourceDescriptions` entry, i.e. a synthetic OpenAPI doc per site: the
  rejected layer, reintroduced. Consequence: OpenAPI is only ever an author-time
  importer (`unknown -> ApiBlock`), off the runtime path.

- 2026-07-27 — **`returns` is JMESPath; `extract`/`errorPath` deliberately are not.**
  The serious alternative was **jsonata**, which is MIT where JMESPath is MPL-2.0 — so
  it wins on licence and lost on language power: `evaluate()` is async, it has
  `function($x){…}` lambdas, and it binds `$eval(str)` with no way to unregister it,
  contradicting the "packages are data, not code" claim the Chrome Web Store positioning
  rests on. **Hard exclusion: `jsonpath-plus`, `jsonpath`, and anything depending on
  `static-eval` — all call `new Function`, which MV3's CSP rejects outright, and both
  carry RCE CVEs (CVE-2024-21534, CVE-2025-1302).** `extract`/`errorPath` stayed locator
  arrays because they name one place in a document: unambiguous, dot-safe, and it keeps
  an expression evaluator out of the two security-adjacent reads.

- 2026-07-28 — **Install bodies are fetched from `sender.origin`, not the build-time
  env var.** The bridge handler validates the sender against the closed
  `externally_connectable` allowlist, then fetches the version body from that same
  origin. One build works against dev (`http://localhost`) and prod
  (`https://webmcp.today`), and the whole class of "installed from localhost, fetched
  from prod" bugs disappears. Attestation is unchanged: the origin set is still fixed
  at build time. Rejected: a build-time constant for the fetch origin — it would be
  wrong in exactly the environment we test in.

- 2026-07-28 — **Popup suggestions come from `GET /api/packages/lookup?url=`, scoped to
  the active tab, not a bundled `@webmcp-today/curated-packages` fallback.** Bundled
  packages are `CreatePackageInput` — no `id`/`versionId` — so routing them through the
  local install path would need synthetic ids that can never be revoked or updated.
  Fetching the site-scoped lookup shows real installable packages, keeps a single
  install path, and drops a dependency and ~30 KB of bundle. The `url` sent is
  `origin + pathname` only — credentials, ports, search and fragments are stripped, so
  suggestion lookups never leak secrets. Rejected: demoting the bundle to a first-run
  suggestion list — it would have required a parallel install path with weaker
  guarantees than the registry one. (An earlier draft of this decision used the
  URL-free `?pageSize=6` browse endpoint; scoping suggestions to the active page won —
  `4288c97` / #98.)

- 2026-07-28 — **The revocations feed carries a `latest` field so the client cursor
  can self-heal.** `revocations.id` is a `bigserial` that restarts at 1 after a DB
  wipe (sanctioned pre-launch); a client whose stored cursor is ahead of the server's
  max would never see another revocation — silent, permanent, and exactly the failure
  the feed exists to prevent. `latest` (max id, or 0) lets the client reset to 0 when
  `stored > latest`. Rejected: an epoch constant bumped on every wipe — more
  operational overhead, and the value already exists in the feed for free.

- 2026-07-28 — **Renamed the project webmcp.cafe → webmcp.today before launch.**
  The product thesis is immediacy ("use WebMCP today, without waiting for sites
  to adopt it"), and the domain is the one-line pitch; "cafe" communicated
  nothing. Done pre-launch because nothing is on npm and there are no users —
  package names (`@webmcp-today/*`, `@robertn702/webmcp-today-*`), env vars
  (`WEBMCP_TODAY_*`), and the extension log prefix (`[webmcp-today]`) all change
  for free now and never again. Rejected: keeping "cafe" (clearer
  community/not-official signal, but a worse pitch) and deferring the rename
  (cost only grows after publish). The old domain stays registered as a
  redirect. Visual identity change was deliberately minimal: ☕→⚡ and copy
  swaps only — the landing's `cafe-*` CSS classes are internal and stayed.

- 2026-07-28 — **HTML token extraction is a raw-text regex (`pattern`), not a
  structured HTML extractor.** HN's write tokens live in HTML (hidden `hmac` input,
  `auth=` vote href), so `extract`'s JSON locator can't reach them. Rejected: a
  name/value hidden-input extractor or CSS-ish selector — each covers exactly one of
  HN's two token shapes (input vs href), so both would have shipped anyway, and any
  HTML parsing invites a full query language one "improvement" at a time. One regex
  primitive covers every shape, keeps the executor parser-free, and fails loudly on
  drift, which is the same rot philosophy as `returns`. Consequence: patterns are
  interpolated RAW with `{{param}}` (nothing regex-escapes them) — params in patterns
  must stay identifier-shaped; that constraint lives in the schema comments, not code.

- 2026-07-29 — **Versions are author-declared positive integers in the package
  definition, validated `=== max(version)+1` at publish.** Registry-assigned
  versions meant a publish couldn't fail on staleness: two authors' agents (or
  one agent working from a cached snapshot) would both succeed, and the second
  silently superseded content the author never saw. Declaring the number makes
  the stale-snapshot case a 409 carrying `expectedVersion` — the same shape as
  the concurrent-publish race, so callers handle one conflict path. Rejected:
  semver (the format has no patch releases — same reasoning as `minEngine`,
  2026-07-24) and keeping server-side assignment with an `If-Match`-style
  precondition header (a second version source of truth outside the document;
  the declared field is the document). The DB is unchanged —
  `uq_package_versions_package_version` is now just the race backstop.

- 2026-07-30 — **Executor extracted from the extension into `packages/engine`
  (MIT) for license separation, not code reuse.** Schema + engine are the MIT
  open-source half of the repo (the package format and the runtime that
  executes it); the extension and web app stay source-available. Nothing else
  consumes the engine today — the boundary is the license, so the split lands
  before launch even with a single consumer. Consequence: `ENGINE_VERSION`
  stays in `packages/schema` (it is format contract, read by the
  registry/publish side for `minEngine` validation) and the dependency is
  one-way engine → schema; `McpResult`/`McpTextContent` moved with the engine
  (`result.ts`) while `model-context.ts`'s DOM feature detection stays in the
  extension as host code.

- 2026-08-09 — **Pre-launch contract hardening kept flat typed columns and one strict
  primitive `inputSchema` profile end-to-end; no content digest.** Served rows now
  re-run publish's cross-field checks too, so a legacy row fails closed; `inputSchema`
  stays primitive-leaf-only with a 64 KiB runtime input cap enforced before
  `window.confirm`/fetch. Rejected: a nested/free-form manifest or full JSON Schema
  (`$ref`/`$defs`, unions) — no consumer needs one and it widens what a reader must
  audit to trust a tool. Also rejected: reintroducing `apiContentHash`/
  `canonicalizeApiBlock` — pin checks, origin allowlisting, and served validation
  already cover tamper-evidence. Consequence: undoing either means widening the union
  or a digest column/migration, not relaxing a cap.

- 2026-08-08 — **Bun is an accepted bridge runtime alongside Node 20+.** The stdio
  host and Unix-socket bridge use runtime-agnostic Node APIs that Bun implements, and
  the wrapper execs the interpreter's absolute path so Chrome launches either identically.
  Rejected: retaining the Node-only guard — it was unverified caution, not a known
  incompatibility. Non-obvious consequence: `native-host-bun.test.ts` gates on a `bun`
  binary, so CI and development environments without Bun silently skip that coverage.
