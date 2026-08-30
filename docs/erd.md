# WebMCP Today — ERD

Source of truth: `packages/db/src/*.ts` (Drizzle). Regenerate this diagram when the
schema changes.

## Registry tables (app-owned)

Package-install model: trust is readable data, explicit consent, and a version you
hold — not per-tool verification. There is no snapshot table — `package_versions`
rows are themselves the served truth.

These tables are in `public`; `users` below is the cross-schema `auth.users` (see the
next section). Mermaid entity names can't carry the qualifier, so the FK notes do.

```mermaid
erDiagram
    users ||--o{ packages : "contributes (contributor_id)"
    users ||--o{ installs : installs
    packages ||--o{ package_versions : "publishes (append-only, cascade)"
    packages ||--o{ installs : "has (cascade)"
    package_versions ||--o{ installs : "pinned to (version_id)"
    packages ||--o{ revocations : "revoked by (cascade)"
    package_versions ||--o{ revocations : "revoked at (version_id, nullable)"
    users ||--o{ revocations : "revokes (revoked_by)"

    packages {
        uuid id PK
        text domain "site key: registrable domain or specific host, idx — immutable after creation"
        text title
        text description
        text contributor_id FK "-> auth.users.id"
        timestamptz created_at
        timestamptz updated_at
    }

    package_versions {
        uuid id PK
        uuid package_id FK "-> packages.id, idx"
        int version "uq: package_id+version"
        jsonb url_patterns "string[] — Chrome @match style, e.g. *://*.wikipedia.org/wiki/*"
        jsonb tools "ToolDescriptor[] — matches zod schema"
        jsonb api "ApiBlock — tier-1 API execution surface (docs/api-execution-model.md)"
        int min_engine "capability floor this version's content requires"
        text changelog "optional, shown to installed users deciding whether to update"
        timestamptz created_at "immutable: no updated_at"
    }

    installs {
        text user_id PK,FK "-> auth.users.id"
        uuid package_id PK,FK "-> packages.id"
        uuid version_id FK "-> package_versions.id, version the user is pinned to"
        timestamptz created_at
        timestamptz updated_at
    }

    revocations {
        bigserial id PK "monotonic — doubles as the client's poll cursor"
        uuid package_id FK "-> packages.id (cascade)"
        uuid version_id FK "-> package_versions.id, NULL = the whole package"
        text reason "short, shown to the user"
        timestamptz revoked_at
        text revoked_by FK "-> auth.users.id"
    }

    aggregate_counters {
        date utc_date PK
        text metric PK
        int count
    }
```

## Auth tables (better-auth-owned — treat the shapes as fixed)

These live in the **`auth` Postgres schema**, not `public` — the tables below are all
`auth.users`, `auth.sessions`, … The split keeps the credential-bearing columns
(`accounts.access_token`/`refresh_token`, `api_keys.key`) behind one schema-level grant
and leaves `public` app-owned.

Column shapes come from better-auth's generated schema and must match the plugin's
expectations. The _table names_ are ours: better-auth resolves models against the
drizzle export names (`user`, `session`, …, `apikey` — kept singular in
`packages/db/src/auth-schema.ts`), never against the SQL name.

```mermaid
erDiagram
    users ||--o{ sessions : has
    users ||--o{ accounts : has
    users ||--o{ api_keys : "authenticates (reference_id)"

    users {
        text id PK
        text name
        text email "unique"
        bool email_verified
        text image
        timestamp created_at
        timestamp updated_at
    }

    sessions {
        text id PK
        text token "unique"
        timestamp expires_at
        text ip_address
        text user_agent
        text user_id FK "-> users.id"
    }

    accounts {
        text id PK
        text account_id
        text provider_id
        text user_id FK "-> users.id"
        text access_token
        text refresh_token
        text id_token
        timestamp access_token_expires_at
        timestamp refresh_token_expires_at
        text scope
        text password
    }

    verifications {
        text id PK
        text identifier
        text value
        timestamp expires_at
    }

    api_keys {
        text id PK
        text config_id "default 'default'"
        text name
        text start
        text reference_id FK "-> users.id"
        text prefix
        text key
        int refill_interval
        int refill_amount
        timestamp last_refill_at
        bool enabled
        bool rate_limit_enabled
        int rate_limit_time_window
        int rate_limit_max
        int request_count
        int remaining
        timestamp last_request
        timestamp expires_at
        text permissions
        text metadata
    }
```

## Reading notes

- **Served truth:** `package_versions` rows directly — no separate snapshot table.
  Browse/fresh lookup validates the highest in-scope candidate and omits the package
  if that candidate is invalid. Installed users stay pinned
  to `installs.version_id` until they explicitly move the pin (npm-style, no
  auto-update); rollback is just setting `version_id` back to an older version.
- **Append-only versions:** publishing a new version never mutates or deletes an old one.
  `packages` (title/description) is the one mutable row per package and is edited
  independently of publishing a version — `domain` is immutable after creation.
  `minEngine` lives on `package_versions`, not the package, since it's a property of
  a version's content.
- **No `(domain, url_pattern)` uniqueness — by design.** Packages are opinions, not
  registrations: rival packages may target the same site. Pattern specificity ranks
  them at lookup time (`rankPackagesByUrl` in `@webmcp-today/schema`);
  an abandoned package never blocks a fresh replacement.
- **`installs` records account-side pins, not a trust signal.** `WHERE user_id = ?`
  is what the MCP server's `install_package` writes (and what the handoff link on
  the package page points at); `version_id` says which version the account is
  pinned to. The extension's local installs live in `chrome.storage.local`, not
  here — this table no longer drives a public trust number.
- **`revocations` is append-only and read-only over HTTP.** Served by
  `GET /api/revocations?since=<cursor>` (public, `WHERE id > cursor ORDER BY id`); writes
  are hand-run SQL in v1 — there is no admin role and no write endpoint. `id` is a
  `bigserial` rather than a random uuid precisely because it is that cursor. It exists
  for the local-install model (`docs/local-first-installs.md` §5): once package bodies
  live on the client's disk, this feed is the only lever the registry keeps after
  install.
- **`aggregate_counters` contains anonymous operational totals only.** Its composite key is
  `(utc_date, metric)` and its only other column is `count`; it has no relationship to a user,
  package, request, or extension installation.
