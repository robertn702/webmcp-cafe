# ⚡ WebMCP Today

WebMCP Today is a registry for declarative packages that add WebMCP tools to
sites that do not expose them. A package describes a site's tools and the API
requests they use. The browser extension installs packages locally and
registers their tools on matching pages.

The registry is live at [webmcp.today](https://webmcp.today).

## OpenAI WebMCP Challenge: Judge Testing

The live site now registers four read-only WebMCP tools directly from
`webmcp.today`. These tools require no WebMCP Today extension or local bridge.

### Test in ChatGPT desktop

1. Use an up-to-date ChatGPT desktop app and a model with WebMCP enabled.
2. Open [https://webmcp.today](https://webmcp.today) in ChatGPT's in-app browser.
3. Ask ChatGPT to use the site's tools with one of the sample prompts below.

### Test in Chrome 149+

1. Open `chrome://flags/#enable-webmcp-testing`, enable WebMCP testing, and relaunch Chrome.
2. Open [https://webmcp.today](https://webmcp.today).
3. Use Chrome's WebMCP-capable agent or tool inspector to discover and invoke the site tools.

### Site tool inventory

| Tool                | Purpose                                                                                                           |
| ------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `search_packages`   | Search all currently servable registry packages by package metadata or tool text, with optional domain filtering. |
| `get_package`       | Return the latest served package document for a package ID.                                                       |
| `compare_packages`  | Compare two to four packages, including common and package-unique tool names.                                     |
| `verify_site_tools` | Show which registry packages match a URL and the tool descriptors those packages would expose there.              |

Sample prompts:

- "Search WebMCP Today for Reddit packages, then show me the full details of the best match."
- "Find packages for Reddit and Google, then compare the best match for each."
- "Verify which registry-provided tools are available for https://news.ycombinator.com/news."

### Eligibility and self-sufficiency

The annotated `pre-webmcp-challenge` tag marks commit `60e3660`, the baseline
before challenge-specific work. [NEW-WORK.md](NEW-WORK.md) is the dated changelog
for work after that tag.

The judge path is self-sufficient within this repository: the Next.js web app
uses its own public API, database, schema package, and curated seed package. It
does not load code or package data from `webmcp-packages` or another repository
at runtime.

Licensing remains split as documented in [License](#license): the server and
database are **AGPL-3.0-only** under the root `LICENSE`; the reusable schema,
engine, MCP bridge, curated packages, skill, and extension carry their own
**MIT** licenses.

## Agent Skill

Install the public skill for researching, creating, validating, and safely testing a
WebMCP Today package:

```bash
npx skills@1.5.22 add robertn702/webmcp-today --skill create-webmcp-package
```

The skill creates `webmcp-package.json` and stops before registry publication.

## Packages

| Path              | What                                                                                                        |
| ----------------- | ----------------------------------------------------------------------------------------------------------- |
| `packages/schema` | `@webmcp-today/schema` — published zod package format                                                       |
| `packages/engine` | `@webmcp-today/engine` — API execution engine                                                               |
| `packages/db`     | Drizzle + Neon schema and client                                                                            |
| `packages/mcp`    | `@webmcp-today/mcp-bridge` — published public-beta registry MCP server + local bridge for live WebMCP tools |
| `apps/web`        | Next.js registry UI + public REST API                                                                       |
| `apps/extension`  | WXT extension: package lookup + WebMCP tool injection                                                       |

## Quickstart

```bash
bun install
bunx turbo run build --filter="@webmcp-today/mcp-bridge..."
bun run typecheck && bun run lint && bun run test

# web (needs apps/web/.env — see .env.example)
cd packages/db && bun run db:migrate   # fresh local Neon only
cd apps/web && bun run dev             # http://localhost:3000
bun run scripts/seed.ts                # optional: seed the curated packages

# extension (Chrome 149+; enable chrome://flags/#enable-webmcp-testing only for Chrome native-agent discovery)
cd apps/extension && bun run dev
```

The extension's local bridge fallback works without the WebMCP testing flag. Enable
the flag when you want Chrome's native agent to discover the extension's tools.

## Development

**Prerequisites:** `bun@1.3.14` (pinned in root `package.json` `packageManager`), Node for Next.js/WXT and some CLIs. The local MCP bridge requires Node 20 or newer or Bun.

**Setup:**

```bash
bun install
bunx turbo run build --filter="@webmcp-today/mcp-bridge..." # creates the opencode.json MCP entrypoint
cp apps/web/.env.example apps/web/.env   # then fill real values
```

`apps/web/.env` needs `DATABASE_URL` (Neon), a per-environment `BETTER_AUTH_SECRET` (`openssl rand -base64 32`), a shared `OAUTH_PROXY_SECRET` for local/Preview/Production (`openssl rand -base64 32`), the development GitHub OAuth App credentials (callback `http://localhost:3000/api/auth/callback/github`), and `BETTER_AUTH_URL=http://localhost:3000`. Leave `OAUTH_PROXY_PRODUCTION_URL` unset locally; in Vercel Preview and Production it is `https://webmcp.today` and routes OAuth through the production GitHub OAuth App callback.

```bash
bun run --filter @webmcp-today/db db:migrate   # or cd packages/db && bun run db:migrate — applies Drizzle migrations to Neon
# schema changes: bun run --filter @webmcp-today/db db:generate && db:migrate (db:push for quick prototyping)

bun run --filter @webmcp-today/web db:seed     # or cd apps/web && bun run db:seed — runs scripts/seed.ts, seeds curated packages
```

These are ordinary fresh-database setup commands. They do not reset an existing
database.

**Historical migration baseline:**
`packages/db/migrations/0000_init.sql` is the initial schema baseline and will
not replay against an existing deployed Neon database. Never reset or recreate
production data to apply it. For schema changes, generate and review a new
Drizzle migration and apply it with `db:migrate`. Run `db:seed` only for fresh
or local databases until it is idempotent and version-aware; use a reviewed
production procedure for curated seed changes.

**Running locally:**

- Web: `cd apps/web && bun run dev` → `http://localhost:3000` (Next.js). Extension's default registry URL points here.
- Extension: `cd apps/extension && bun run dev` → WXT dev server on `http://localhost:5173`, launches a dedicated Chrome profile at `.wxt/chrome-profile/` with `--enable-features=WebMCP,WebMCPTesting` force-enabled (`chrome://flags` still shows "Default" — check `chrome://version`). One instance only — second crashes on profile lock and corrupts `.output/`. Model Context Tool Inspector is installed once into that profile and persists.
- Local bridge: configure the native host in `packages/mcp/README.md`, then start `node packages/mcp/dist/index.js`. Its MCP tools invoke live WebMCP tools in the selected normal Chrome tab without Chrome DevTools MCP, a remote-debugging port, or `chrome.debugger`. The built-in fallback works without the WebMCP testing flag; enable it only for Chrome's native agent to discover the tools.
- Ports: web 3000 / WXT 5173. Find strays with `lsof -nP -i :3000 -i :5173`; killing a bun wrapper does NOT kill its node child.

**Quality gates:** `bun run typecheck && bun run lint && bun run test` before every commit — same as CI (`.github/workflows/ci.yml` via `oven-sh/setup-bun@v2` `1.3.14` + `--frozen-lockfile`). Pre-commit runs `husky` + `lint-staged` (eslint + prettier on staged source, prettier on json/md/css/yaml) and enforces `CLAUDE.md -> AGENTS.md` symlink drift.

**Deeper context:** root `AGENTS.md` (stack, conventions, decisions log, cross-cutting gotchas) and nested `apps/web/AGENTS.md` (package-install registry model, served truth, env/t3-env notes) + `apps/extension/AGENTS.md` (dev browser, silent-fallback trap, selector-rot recipe).

## License

Split, so the pieces worth adopting stay permissive:

- **AGPL-3.0-only** — the server: `apps/web` and `packages/db` (root `LICENSE`). Run a modified copy as a network service and you owe your users the source.
- **MIT** — everything built to be adopted freely: `packages/schema` (package format), `packages/engine` (execution engine), `packages/mcp` (MCP server), `packages/curated-packages` (curated packages), and `apps/extension` (browser extension). Each carries its own `LICENSE`.

Community-submitted packages are not code and are not covered by either license. Publishing one grants the registry a permanent license to host and redistribute it, and offers it onward under **CC0 1.0** — see [the terms](https://webmcp.today/terms) (`apps/web/app/(registry)/terms`). `packages/curated-packages` is the first-party exception: it ships as MIT source.

Contributions are covered by the agreement in [CONTRIBUTING.md](CONTRIBUTING.md).
