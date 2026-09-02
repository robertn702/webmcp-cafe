# AGENTS.md — WebMCP Today

Community registry of third-party WebMCP packages injected into sites that haven't
implemented WebMCP — "Greasyfork for the agentic web".

## Layout

```
apps/web/          Next.js — registry UI + public REST API
apps/extension/    WXT — package lookup + tool injection
packages/schema/            @webmcp-today/schema — published zod package format; keystone, all consumers validate against it
packages/engine/            @webmcp-today/engine — API execution engine (not yet published to npm); MIT, consumed by the extension
packages/db/                Drizzle + Neon — schema + client
packages/curated-packages/  @webmcp-today/curated-packages — curated first-party packages (registry seed source)
packages/mcp/               @webmcp-today/mcp-bridge — published public-beta MCP server
```

## Commands

| Task      | Command             |
| --------- | ------------------- |
| Typecheck | `bun run typecheck` |
| Lint      | `bun run lint`      |
| Test      | `bun run test`      |
| Build     | `bun run build`     |

- Lint runs once at the root; typecheck/test/build fan out via turbo. `apps/web` build
  needs real env vars (t3-env validates at build).

## Deploy, domain & DNS

- The Vercel project is linked via `.vercel/project.json`. The GitHub integration
  deploys Production from `main` and a Preview per PR; `vercel --prod` is the manual
  override. Migrate Neon before merging schema-breaking changes, or expect a window
  of 500s.
- Required production environment variables must be configured in Vercel or the build
  fails at "Collecting page data" (t3-env validates on import). Use
  `apps/web/.env.example` for the required local and deployed names; production
  `BETTER_AUTH_URL` must use the production origin.
- Keep the canonical domain's DNS records pointed at Vercel and redirect any legacy
  domain to it. Fix an errored production deployment before attaching a domain.
- Configure separate GitHub OAuth applications for local development and production:
  each application permits only one callback URL.
- `.github/workflows/cleanup-neon-preview.yml` removes Neon Preview branches after a
  PR closes. It requires the `NEON_PROJECT_ID` repository variable and
  `NEON_API_KEY` secret; closed Preview URLs intentionally lose database access.

## Stack (decided — do not relitigate)

Bun + Turborepo, TypeScript strict ESM, Next.js + React 19 + Tailwind 4 + shadcn/ui,
Next route handlers + zod (no tRPC), Neon Postgres + Drizzle, better-auth (GitHub OAuth
\+ API-key plugin), zod v4, @t3-oss/env, Vitest, ESLint + Prettier, Changesets
(currently not in use), @modelcontextprotocol/sdk.

## Conventions

- No `as` assertions except `as const` (ESLint-enforced) — validate with zod at
  boundaries, narrow with runtime checks.
- Simplicity bias: smallest version that works; no abstraction without a current need.
- Conventional commits; keep `main` green (typecheck + lint + test before committing).
- Skills install project-locally via `npx skills add` (never `-g`).
- opencode users: copy `opencode.example.json` → `opencode.json` (gitignored) to
  opt into the local `webmcp-today` MCP bridge; requires `packages/mcp` built.
- Once a package is published to npm, its `files` array must list `LICENSE`.
- `CLAUDE.md` symlinks to `AGENTS.md` (pre-commit auto-creates) — never diverge them.
- Env: `apps/web/.env.example` lists required vars (`DATABASE_URL`, GitHub OAuth,
  `BETTER_AUTH_SECRET`, `OAUTH_PROXY_SECRET`, `OAUTH_PROXY_PRODUCTION_URL`).

## WebMCP essentials (July 2026)

- Feature-detect: `const mc = document.modelContext ?? navigator.modelContext`.
- `await mc.registerTool({ name, description, inputSchema, execute, annotations }, { signal })`
  — rejects on duplicate names.
- Chrome origin trial 149→156; local dev **and end users** need
  `chrome://flags/#enable-webmcp-testing` for Chrome's native agent to see our
  tools, but the extension's built-in fallback registers tools without the flag
  (reachable via the WebMCP Today bridge only) — sites we inject into never serve
  an origin-trial token on our behalf (docs/DECISIONS.md 2026-07-24).
- Char budgets (Chrome guidance): we enforce 500/tool description, 150/param
  description, 30/name at publish time; tool output is uncapped in v1 (Chrome's 1.5K is
  guidance, not enforcement — see docs/DECISIONS.md 2026-07-24).
- Platform risks (unsanctioned extension registration, `tools=()` kill switch):
  docs/platform-risks.md; track webmachinelearning/webmcp#74.

## Package format

- `{ version, domain, urlPatterns[], title, description, tools[], api, minEngine, changelog? }`;
  `urlPatterns` is Chrome `@match`-style (`scheme://host/path`), versioned alongside
  `tools`, `api`, and `minEngine`.
- `version`: author-declared positive integer (not semver) — `1` on create, exactly
  `max(version)+1` on publish, or the API 409s with `expectedVersion`
  (docs/DECISIONS.md 2026-07-29).
- Tool `execution` is discriminated: API tools bind to `api.endpoints`; DOM tools
  declare bounded, read-only semantic observations and require `minEngine: 2`.
  `api` remains required; DOM-only packages carry an inert same-site
  `api.endpoints: {}` block. Publish schema first, then the engine minor release,
  before publishing packages that require DOM mode.
- `minEngine`: positive-integer capability level (not semver), version-scoped.
- Extension must skip + warn on tool-name collision with site-registered tools.
- `ENGINE_VERSION` is `2`, which adds the DOM observation executor. Bump the capability
  level only for an incompatible format change (`packages/schema/src/budgets.ts` says why).
- Tier-1 `api` block: `returns` is a JMESPath expression; `errorPath` and auth-source
  `extract` are locator arrays (`["json","errors"]`); an auth source declares exactly
  one of `extract` (JSON locator) or `pattern` (regex over the raw response text,
  capture group 1 = token — for HTML token sources like HN); `sendAs` is `{in, name}`
  with `in` one of `header`/`form`/`query`; `stripPrefix` is a literal response
  prefix removed before JSON parsing (Google's anti-XSSI `)]}'` — Maps/Gmail); an
  endpoint declares at most one of `graphql`/`form`/`body`. A `body` or
  `graphql.variables` leaf that is exactly one `{{param}}` keeps its type. Endpoint
  `baseUrl` normally stays on the package domain; the only cross-origin exception is
  anonymous `GET` reads from `https://hacker-news.firebaseio.com`, with no auth,
  omitted cookies, and rejected redirects.
- **Never add `jsonpath-plus`, `jsonpath`, or anything depending on `static-eval`** —
  they call `new Function`, which MV3's CSP rejects in the content script, and both
  carry RCE CVEs. Response projection is `@jmespath-community/jmespath` (no `eval`).
  Reasoning: `docs/DECISIONS.md` 2026-07-27.

## Registry data model

- `packages` (mutable) / `package_versions` (append-only; the served truth) /
  `installs` (auth-only per-user version pins). Browse serves the highest in-scope
  candidate only after full envelope validation and omits a package whose candidate
  is invalid; users stay on their pinned version. ERD: `docs/erd.md`; served-truth rules:
  `apps/web/AGENTS.md`.
- No `(domain, url_pattern)` uniqueness — rival packages may target the same site;
  local browser installs select candidates, and matching candidates rank by pattern specificity.
- Two Postgres namespaces: app tables in `public`, better-auth's in `auth`
  (`auth.users`, …) — hand-run SQL must qualify. See `apps/web/AGENTS.md` § Auth.

## Gotchas

- In managed agent runs, keep temporary logs, response bodies, headers, and scripts
  under the repo-local `.scratch/` directory, never `/tmp` or another external path.
  Remove those artifacts before staging. Run verification in the foreground and fail
  immediately if a command requests interactive permission; waiting silently will
  trigger the runtime idle watchdog.
- drizzle-kit `generate` prompts interactively on renames (needs a TTY) — use
  `generate --custom`, hand-fill SQL + meta snapshot, verify with plain `generate`.
- `packages/schema` resolves via `dist/` — rebuild it after schema changes or consumers
  see bizarre validation errors.
- Ports: web 3000 / WXT 5173 — find strays with `lsof -nP -i :3000 -i :5173`;
  killing a bun wrapper does NOT kill its node child.

## Decision log (`docs/DECISIONS.md`)

Append an entry only when all three hold; otherwise the artifact _is_ the record, so
don't restate it.

1. A real alternative was rejected — not "built the obvious thing".
2. The reasoning is **not** recoverable from the code, schema, config or another doc.
3. A future agent could plausibly undo or relitigate it.

Never log implementation narratives, "verified X works" sessions, scaffolding/lint/docs
housekeeping, or anything an `AGENTS.md` / `ARCHITECTURE.md` / `docs/*` already says.
Anything an agent must obey _right now_ belongs in the nearest `AGENTS.md`; the log
holds only the why.

Format: one dated bullet, ≤10 lines, bold lede stating the decision, then the why, then
the non-obvious consequence — the rejected alternative is the valuable half. When a
decision supersedes an older entry, **rewrite or delete that entry** instead of stacking
a correction, and prune entries whose reasoning has since migrated into code or docs.

## References

| Need                            | File                                                                                                                            |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| System architecture + diagrams  | `ARCHITECTURE.md`                                                                                                               |
| Web app + API notes             | `apps/web/AGENTS.md`                                                                                                            |
| Extension notes                 | `apps/extension/AGENTS.md`                                                                                                      |
| Extension internal map          | `apps/extension/ARCHITECTURE.md`                                                                                                |
| Data model ERD                  | `docs/erd.md`                                                                                                                   |
| Execution model                 | `docs/api-execution-model.md`                                                                                                   |
| Platform risk register          | `docs/platform-risks.md`                                                                                                        |
| Why non-obvious calls were made | `docs/DECISIONS.md`                                                                                                             |
| Open follow-ups (prune as done) | `docs/BACKLOG.md`                                                                                                               |
| Reference impl (MIT, ported)    | [web-mcp-hub](https://github.com/Joakim-Sael/web-mcp-hub) + [webmcp-extension](https://github.com/Joakim-Sael/webmcp-extension) |
