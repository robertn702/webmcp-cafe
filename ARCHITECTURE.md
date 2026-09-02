# WebMCP Today — Architecture

Community registry of third-party **WebMCP packages** injected into sites that
haven't implemented WebMCP — "Greasyfork for the agentic web". This document is the
map of how the pieces fit together. Companion docs:

| Need                | File                                                                         |
| ------------------- | ---------------------------------------------------------------------------- |
| Stack + conventions | `AGENTS.md`                                                                  |
| Data model (ERD)    | `docs/erd.md`                                                                |
| API execution model | `docs/api-execution-model.md`                                                |
| Package format      | `packages/schema/src/` + `AGENTS.md`                                         |
| Web app specifics   | `apps/web/AGENTS.md`                                                         |
| Extension specifics | `apps/extension/AGENTS.md` + `apps/extension/ARCHITECTURE.md` (internal map) |

## System overview

Three deployables and three libraries, all revolving around one shared package format:

```mermaid
flowchart LR
    subgraph Consumers
        BA["Browser agent<br/>(in-page LLM / browser AI)"]
        TA["Terminal agent<br/>(any MCP client)"]
    end

    subgraph Browser["User's browser"]
        EXT["apps/extension<br/>(WXT / MV3)"]
        PAGE["Any website<br/>(user's logged-in session)"]
        EXT -- "registerTool()" --> PAGE
        BA -- "invoke tool" --> PAGE
        PAGE -- "declared API tool" --> EXT
    end

    subgraph Registry["Registry (apps/web — Next.js)"]
        UI["Registry UI<br/>(browse, submit, install)"]
        API["REST API<br/>(route handlers + zod)"]
        AUTH["better-auth<br/>(GitHub OAuth + API keys)"]
    end

    DB[("Neon Postgres<br/>(packages/db — Drizzle)")]
     MCP["packages/mcp<br/>MCP server (stdio)"]
     HOST["Native host<br/>private local IPC"]

    UI -. "install bridge<br/>(externally_connectable)" .-> EXT
    EXT -- "GET /api/revocations ·<br/>GET /api/domains (alarms)" --> API
     MCP -- "REST (+ Bearer API key)" --> API
     MCP -- "user-only Unix socket" --> HOST
     HOST -- "native messaging" --> EXT
    TA --> MCP
    UI --> API
    API --> AUTH
    API --> DB
```

- **`apps/web`** — the registry. Next.js UI for humans + public REST API for
  everything else. Owns auth (better-auth) and all persistence.
- **`apps/extension`** — the delivery mechanism. A content script on every page asks
  the background worker for packages matching the URL; the worker resolves them from
  `chrome.storage.local` (no network on page load) and the content script registers
  their tools through the native `document.modelContext` API when available, otherwise
  a document-local fallback served through the WebMCP Today bridge. Installs arrive over an `externally_connectable` bridge from the registry
  site; the only other HTTP the extension makes is a revocation poll and a domain
  list, both on `chrome.alarms`.
- **`packages/mcp`** — a stdio MCP server so terminal agents can search, publish, and
  install packages without a browser. It also exposes a narrow local bridge to
  list and execute live WebMCP tools in the user's selected browser tab. The
  native host only relays zod-validated messages; it is not a CDP/HTTP proxy. Its
  pinned `npx` command runs under Node; setup may source the bundled host from the
  ephemeral npx cache but copies it durably to `~/.config/webmcp-today`.
  stable discovery symlink is atomically replaced only when a session starts; shutdown
  removes only that session's private socket/config, so connection success determines
  availability rather than the presence of a potentially stale discovery path.
- **`packages/schema`** — the keystone. The zod package format every consumer validates
  against; published as `@webmcp-today/schema`.
- **`packages/engine`** — the execution engine
  (`@webmcp-today/engine`, MIT): turns a package's declarative `api`
  block into HTTP requests pinned to its `api.baseUrl` origin, plus the `minEngine` gate. Extracted from
  the extension for license separation (`docs/DECISIONS.md` 2026-07-30); the
  extension is its only consumer today.
- **`packages/db`** — Drizzle schema + Neon client, shared by `apps/web`.
- **`packages/curated-packages`** — the curated first-party corpus
  (`@webmcp-today/curated-packages`): the registry's seed source.

## Package dependency graph

```mermaid
flowchart TD
    schema["packages/schema<br/>(published)"]
    engine["packages/engine<br/>(published)"]
    db["packages/db"]
    defs["packages/curated-packages"]
    web["apps/web"]
    ext["apps/extension"]
    mcp["packages/mcp<br/>(published)"]

    web --> schema
    web --> db
    web --> defs
    ext --> schema
    ext --> engine
    engine --> schema
    mcp --> schema
    defs --> schema
```

`packages/schema` has no inbound dependencies and is resolved via its built `dist/` —
rebuild it after schema changes or consumers see bizarre validation errors. Turbo
fans out `build`/`typecheck`/`test` with `dependsOn: ["^build"]`, so schema always
builds first.

## Runtime flow — tool registration (extension)

```mermaid
sequenceDiagram
    participant P as Web page
    participant CS as Content script
    participant BG as Background worker
    participant ST as chrome.storage.local
    participant MC as document.modelContext

    P->>CS: document_idle
    CS->>BG: sendMessage(getPackagesForUrl)
    BG->>ST: get("index")
    BG->>ST: get("pkg:<id>") for each match
    BG->>BG: domainLookupKeys → rankPackagesByUrl → drop revoked → minEngine gate
    alt revocation list missing (fail-closed)
        BG-->>CS: no packages (paused, waiting on the safety list)
    else
        BG-->>CS: matched packages, most-specific first
    end
    loop each package
        CS->>CS: skip on name collision with site tools (form[toolname] or already seen)
        loop each tool
            CS->>MC: registerTool({ name, description, inputSchema, execute })
        end
    end
```

Key behaviors:

- **Page loads never hit the network.** The background resolves every URL from
  `chrome.storage.local` (install index + bodies); all logging lands in the **page
  console**, with `[webmcp-today] N installed package(s) matched this URL` as the
  ground-truth line.
- **Fail-closed gate:** if the revocation list is missing (a fresh client that has
  never completed a poll), the worker registers nothing and reports
  `safety-list-missing`. A package can only enter storage via the install bridge,
  which bootstraps the list, so this state is unreachable in normal use — it is the
  belt for the braces.
- **Engine gate:** a package whose `minEngine` exceeds the extension's level is skipped
  wholesale — a too-new package must never register inert or mis-executed tools.

## Runtime flow — tool invocation

```mermaid
sequenceDiagram
    participant A as Agent
    participant MC as document.modelContext
    participant EX as Executor (extension)
    participant S as Target site

    A->>MC: invoke tool(name, input)
    MC->>EX: execute(input)
    EX->>EX: validate input against inputSchema + 64 KiB cap — reject before any side effect
    EX->>EX: destructiveHint? block on window.confirm
    EX->>EX: bind param templates, acquire auth tokens (e.g. CSRF)
    EX->>S: fetch pinned to api.baseUrl origin (user's cookies ride along)
    S-->>EX: JSON (errorPath checked, returns projection applied)
    EX-->>A: tool output (uncapped in v1)
```

Two execution modes are selected per tool:

- **API mode (tier 1)** — the package declares the site's own HTTP API as data
  (`api.endpoints`, `auth` token sources, `returns` projections); the executor derives
  and performs the call. Ships zero code. The load-bearing invariant: **`api.baseUrl`
  must normally use the package domain or a subdomain, and every derived request is
  pinned to that exact origin after interpolation**. The sole cross-origin exception is
  anonymous `GET` reads from `https://hacker-news.firebaseio.com`, with no auth,
  omitted cookies, and rejected redirects. `urlPatterns` select pages for tool
  registration; they do not constrain `api.baseUrl` or need to cover it. Tiers 2–3 (scoped script slots, full `evaluate`) are designed
  but not shipped — see `docs/api-execution-model.md`.
- **DOM mode (level 2)** — reads only a bounded, top-level light-DOM set of exact
  semantic role/name observations. It cannot mutate, inspect values/HTML/URLs, or
  traverse frames or shadow roots. DOM-only packages retain an inert same-site API block.
- **Validate before any side effect.** The executor re-validates input against the
  tool's `inputSchema` (primitive-only profile) and a 64 KiB serialized-input cap
  before the `destructiveHint` confirm prompt or any network access — an invalid call
  never reaches the user-facing confirm dialog or the site.

`destructiveHint` tools gate on a blocking `window.confirm` — writes wait for a human.

## Data flow — publish, install, serve

```mermaid
sequenceDiagram
    participant C as Contributor (human or agent)
    participant W as apps/web REST API
    participant D as Neon (packages/db)
    participant P as Registry site (page)
    participant E as Extension background
    participant ST as chrome.storage.local

    C->>W: POST /api/packages (session cookie or Bearer API key)
    W->>W: zod-validate against @webmcp-today/schema
    W->>D: insert packages + package_versions v1
    C->>W: POST /api/packages/:id/versions (owner only)
    W->>D: append version N+1 (never mutates N)

    P->>E: install bridge: { type:"install", packageId, versionId }
    E->>W: GET <origin>/api/packages/:id/versions/:versionId
    W-->>E: served body (webMcpPackageSchema)
    E->>E: validate against webMcpPackageSchema; bootstrap revocation list if absent
    E->>ST: atomic set({ pkg:<id>: body, index: next })

    E->>W: GET /api/revocations?since=cursor (alarms: 6h + startup)
    W-->>E: append-only kill list (latest = max(id) → self-healing cursor)
    E->>W: GET /api/domains (alarms: daily)
    W-->>E: domain set for the discovery badge
```

The model in one breath: `packages` is the one mutable row per package
(title/description; `domain` is immutable after creation); `package_versions`
is append-only and **is** the served truth (no snapshot table). Page-load resolution is purely local — the
extension matches its install index against the URL and reads the bodies from
`chrome.storage.local`, with no network hop. The registry retains exactly two
levers after install: the revocation feed (enforced at registration time against
bodies already on disk) and the version a user chooses to install next.
Account-side `installs` rows still record pins made through the MCP server
(Mode 01) and feed the handoff link, but no browser reads them. Full schema:
`docs/erd.md`.

## Package format

A package is pure data — `{ version, domain, urlPatterns[], title, description, tools[], api, minEngine, changelog? }`,
validated by zod in `packages/schema`:

- `urlPatterns` — Chrome `@match`-style; used for lookup and ranking
  (`rankPackagesByUrl`).
- `tools[]` — `{ name, description, inputSchema, annotations?, execution }` with
  WebMCP metadata budgets enforced (500/description, 150/param, 30/name — tool output
  is uncapped in v1; `packages/schema/src/budgets.ts`).
- `api` — required API execution surface. Its `baseUrl` host must be the package
  domain or a subdomain; the executor rejects a derived URL whose origin differs
  from the exact `baseUrl` origin after interpolation.
- `minEngine` — positive-integer capability level per version; lets the format evolve
  without old executors silently mis-running new packages.
- Placeholders (`{{param}}`, double-brace) may only name `inputSchema` properties —
  cross-validated at the schema level for API endpoints.

## Auth & trust

- **Auth (apps/web):** better-auth — GitHub OAuth + email/password for the browser
  (session cookies); API keys (`Authorization: Bearer …`) for agents. The apiKey
  plugin keys owners as `reference_id`, not `user_id` — keep
  `packages/db/src/apikey-schema.ts` matched to the plugin. Auth tables are plural
  snake_case in SQL (`users`, `api_keys`, …) but keep singular drizzle **export**
  names, which is the only name better-auth resolves (`apps/web/AGENTS.md` § Auth).
- **Trust = readable data, explicit consent, and a version you hold.** No per-tool
  verification, no approval gate: rival packages may target the same site, ranked by
  pattern specificity alone. Nothing registers that you didn't install; the installed
  body lives on disk, so a malicious or broken update reaches you only when you move
  the pin (the Greasyfork model); and the whole package is a JSON document you can
  read before running it. The registry's one post-install lever is the revocation
  feed (`docs/local-first-installs.md` §5).

## Repository & build topology

```
webmcp-today/
├── apps/
│   ├── web/            # Next.js — registry UI + public REST API (port 3000)
│   └── extension/      # WXT — package lookup + tool injection (dev port 5173)
├── packages/
│   ├── schema/            # @webmcp-today/schema — zod package format (published)
│   ├── db/                # Drizzle + Neon — schema + client
│   ├── curated-packages/  # @webmcp-today/curated-packages — curated first-party packages (registry seed source)
│   └── mcp/               # @webmcp-today/mcp-bridge — MCP server (published)
└── docs/               # erd.md, api-execution-model.md, DECISIONS.md
```

- Bun workspaces + Turborepo; root `bun run typecheck && bun run lint && bun run test`
  is the pre-commit gate (same as CI).
- Publishing uses Changesets; published packages list `LICENSE` in `files`.
- Local dev needs Chrome 149+ for the extension; enable WebMCP flags
  (`--enable-features=WebMCP,WebMCPTesting`) only to exercise Chrome's native
  agent. The local bridge fallback works without them. The web app needs a Neon
  `DATABASE_URL` + GitHub OAuth + `BETTER_AUTH_SECRET`.
