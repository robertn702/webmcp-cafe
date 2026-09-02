# API-Backed Tools — Execution Model

> Status: **tier 1 is built and shipping** (`packages/schema/src/api.ts`,
> `packages/engine/src/api-executor.ts`, `packages/curated-packages/data/reddit.com.json`);
> tiers 2–3 remain proposals. Where this doc and the code disagree, the code wins.
> Related: `AGENTS.md` (package format), `docs/erd.md` (installs/version pinning),
> `packages/schema/src/` (execution descriptors).

## Motivation

The original package format executed tools by driving the DOM: CSS selectors, form
fills, clicks. That works, but it rots _silently_ — the Wikipedia package broke on day
one when the article DOM changed shape, and nothing about the failure was visible
until a human noticed. Selector rot is the expected failure mode of every DOM-backed
package, and the DOM model had no way to detect it short of a health canary.

Most sites we care about already expose the operation as an HTTP call their own frontend
makes. Executing a tool as a **declared API call** instead of a DOM choreography gives us:

- **Structured output.** JSON responses are what an LLM actually wants to consume —
  no extraction heuristics, no HTML-to-text loss.
- **Loud failures.** A 4xx/5xx, a schema mismatch, or a rotated GraphQL persisted-query
  hash fails immediately and detectably. Selector rot fails quietly; API rot fails loudly.
- **Smaller, stabler packages.** The Reddit API surface changes far less often than
  Reddit's markup.

Flagship target: a **read + write Reddit package** backed by its JSON API — readable
threads, plus posting comments — controllable from a terminal LLM through WebMCP. That
requires authenticated writes, which forces the token-acquisition design below.

API execution remains the general execution model. Engine level 2 also supports a deliberately narrow DOM read mode: exact semantic role/name observations with `matched` and only `disabled`, `checked`, or `required` boolean output. It cannot use selectors, values, HTML, frames, shadow roots, or mutation operations. DOM-only packages currently carry an inert same-site `api` block with `endpoints: {}`; publishing this format requires schema and engine minor releases and `minEngine: 2`.

## Tiered execution model

Three tiers, in strict order of preference. A package author reaches for the lowest tier
that expresses the tool; the registry's curation bar rises with the tier.

| Tier | What it is                                                                    | Code shipped                         | Network                                       | Curation bar           |
| ---- | ----------------------------------------------------------------------------- | ------------------------------------ | --------------------------------------------- | ---------------------- |
| 1    | Declarative `api` block — the executor derives and performs the HTTP call     | None (pure data)                     | Executor-mediated, pinned to `baseUrl` origin | Normal                 |
| 2    | Scoped script slots — small stringified-JS hooks bound to narrow capabilities | Small string functions, pure compute | Never — slots cannot touch the network        | Elevated (code review) |
| 3    | Full `evaluate` — stringified async JS escape hatch                           | Arbitrary async function             | Executor-mediated, pinned to `baseUrl` origin | Highest; flagged in UI |

The unifying safety property: **the executor starts requests at the declared `baseUrl`
origin**, except Hacker News's fixed anonymous Firebase read origin. The exception permits
only `GET` requests to `https://hacker-news.firebaseio.com`, with no auth sources, omitted
cookies, and rejected redirects. `baseUrl` must otherwise use the package domain or a
subdomain, but does not need to equal the current page origin or be covered by
`urlPatterns`; every request rejects redirects. Tier 2 cannot access the network.
Tier 1 has no arbitrary code, and the Firebase exception cannot carry
ambient site cookies or declared auth sources; it still sends the endpoint's declared
path/query built from tool input to that origin. Tier 3 has network access but only through
the executor's origin-pinned fetch. Keeping tiers 1–2 reviewable is what
make human curation tractable. Reviewers check _what the tool does on the
site_, not whether it leaks data off it.

## Tier 1 — the `api` block

The package declares the site's API surface as data; the executor constructs the request,
performs it, and projects the response. Zero code is shipped.

Current schema shape (implemented and validated in `packages/schema`):

```jsonc
{
  // top-level, next to tools[] — shared across the package's API tools
  "api": {
    "baseUrl": "https://www.reddit.com",
    "auth": {
      "csrf": {
        // fetch this, extract the token, attach it to subsequent calls
        "source": { "endpoint": "me", "extract": ["data", "modhash"] },
        "sendAs": { "in": "header", "name": "X-Modhash" },
        // omit to re-fetch the token on every request (the safe default)
        "ttlSeconds": 300,
      },
    },
    "endpoints": {
      "me": { "method": "GET", "path": "/api/me.json" },
      "subredditHot": {
        "method": "GET",
        "path": "/r/{{subreddit}}/hot.json",
        "query": { "limit": "{{limit}}" },
        "returns": "data.children[].data.{title: title, author: author, score: score}",
      },
      "comment": {
        "method": "POST",
        "path": "/api/comment",
        "form": {
          "thing_id": "{{thingId}}",
          "text": "{{text}}",
          "api_type": "json",
        },
        "auth": ["csrf"],
        "errorPath": ["json", "errors"],
      },
      "searchGraphql": {
        "method": "POST",
        "path": "/svc/shreddit/graphql",
        "graphql": {
          "document": "@documents/search",
          "variables": { "query": "{{query}}", "first": "{{first}}" },
        },
        "errorPath": ["errors"],
        "returns": "data.search.posts[].{id: id, title: title}",
      },
    },
    "documents": {
      // named static GraphQL documents, referenced as @documents/name.
      // Real captured queries are far too long to inline per-endpoint.
      "search": "query Search($query: String!, $first: Int) { ... }",
    },
  },
}
```

And a tool binds to an endpoint:

```jsonc
{
  "name": "reddit_subreddit_hot",
  "description": "List hot posts in a subreddit.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "subreddit": { "type": "string", "description": "Subreddit name, no r/ prefix" },
      "limit": { "type": "integer", "description": "Max posts (default 25)" },
    },
    "required": ["subreddit"],
  },
  "annotations": { "readOnlyHint": true },
  "execution": { "mode": "api", "endpoint": "subredditHot" },
}
```

Field semantics:

- **`baseUrl`** — must use the package's declared domain or one of its subdomains.
  It need not equal the current page origin or be covered by `urlPatterns`; after
  interpolation, the executor refuses every derived URL whose origin differs from
  this exact `baseUrl` origin. The only endpoint-level exception is Hacker
  News's anonymous Firebase read API; the executor omits cookies and rejects
  redirects for every request. That exception cannot use auth sources, and auth
  sources must fetch from the primary `api.baseUrl`.
- **`auth` / token sources** — named credential acquisition flows. The CSRF example:
  GET `/api/me.json`, extract `["data", "modhash"]` from the JSON, send as the
  `X-Modhash` header on endpoints listing `auth: ["csrf"]`. Cookies ride along
  automatically (the executor sends credentials with the origin-pinned request). Extraction is exactly one of: **`extract`** (a locator into a JSON
  response) or **`pattern`** (a regex against the raw response text, capture group 1 =
  the token — for sites like Hacker News whose tokens live in HTML: a hidden form input,
  an `auth=` href). A `pattern` may carry `{{param}}` placeholders; each value is
  regex-escaped and therefore matches literal text. `sendAs` is `{in, name}` with `in` one of `"header"`
  (Reddit's X-Modhash), `"form"` (HN's hmac — the endpoint must declare a `form` body),
  or `"query"` (HN's vote auth). **`ttlSeconds`** caches a fetched token across tool
  calls, keyed by the RESOLVED fetch URL + extraction spec — a parameterized source
  (`/item?id={{itemId}}`) caches per param value, so item A's token never leaks into a
  call about item B. Omitting it re-fetches on every request, which is the safe default
  and was the only behaviour before the field existed.
- **`path` / `query` / `body` / `form`** — `{{param}}` templates bound from the
  validated tool input (cross-validated at the schema level;
  placeholders may only name `inputSchema` properties). Paths always interpolate, so an
  absent param and mixed templates produce an empty string at that position. A query or
  form field is omitted only when its template is **exactly** one placeholder and that
  property is absent from the validated input; mixed templates still interpolate. An
  explicitly supplied empty string, `0`, or `false` remains present (query/form values
  are strings on the wire). In a `body` or in `graphql.variables`, a string that is
  **exactly** one placeholder emits the raw typed value — `"{{n}}"` sends `10`, not
  `"10"` — while `"page {{n}}"` concatenates; absent exact leaves become `undefined`
  and JSON drops object properties.
- **Tool input** — must be a plain object with only declared primitive fields and a
  serialized size of at most 64 KiB. Invalid input returns validation issues before a
  destructive confirmation or network request.
- **Endpoint path and method** — `path` starts with exactly one `/` and cannot contain
  `//`, backslashes, query strings, fragments, or `.`/`..` segments. An endpoint may
  declare at most one of `body`, `form`, or `graphql`; `GET` declares none of them.
- **`returns`** — a **JMESPath** expression applied to the JSON response to trim output
  for density and relevance. There is no hard output cap in v1 (the 1.5K
  `TOOL_OUTPUT_MAX` was removed — model-dependent; the budget question is deferred, see
  docs/DECISIONS.md 2026-07-24), so projection is about signal-to-noise, not fitting a
  fixed budget. Missing from a tool's output? Add or widen the projection. A projection
  that matches nothing **fails the call** rather than quietly returning the whole
  response — that is the API-shape-changed signal, and the whole point of preferring API
  execution over DOM execution.
  > **Caveat:** "matches nothing" means the projection evaluates to JMESPath's `null`
  > (e.g. a path segment that no longer exists) — that throws, distinguishing API rot
  > from a legitimate empty result. An empty array (`[]`, "no posts in this subreddit")
  > is a real result and passes through untouched; only `null`/`undefined` is treated as
  > failure.
- **`errorPath`** — where errors live in a 200 response body, as a locator array (e.g.
  `["errors"]` for GraphQL's 200-with-errors convention, `["json", "errors"]` for
  Reddit's REST API). A non-empty value at that path = tool failure, surfaced as an
  error to the agent. An array rather than a dot string so a key containing a dot is
  unambiguous; `extract` takes the same shape for the same reason.
- **`stripPrefix`** — a literal response-body prefix to strip before JSON parsing.
  Exists for Google's anti-XSSI marker (`")]}'"`), which every `google.com` internal
  JSON endpoint (Maps, Gmail) prepends; the Google Maps curated package is the
  reference user. A literal string rather than a boolean so the executor carries no
  site-specific constants, and stripped only when present so a site dropping its own
  prefix doesn't break a working package.
- **`documents`** — package-level named static GraphQL documents; endpoints reference
  them as `@documents/name`. Keeps megabyte-adjacent captured queries out of the
  per-endpoint inline JSON and dedupes documents shared by several endpoints.

Reddit write example — the tool that makes this model worth building:

```jsonc
{
  "name": "reddit_comment",
  "description": "Post a comment on a post or reply to a comment.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "thingId": { "type": "string", "description": "Fullname, e.g. t3_abc123 or t1_def456" },
      "text": { "type": "string", "description": "Comment body (markdown)" },
    },
    "required": ["thingId", "text"],
  },
  "annotations": { "readOnlyHint": false },
  "execution": { "mode": "api", "endpoint": "comment" },
}
```

The contributor never writes code. The modhash dance — the fiddliest part of Reddit
write automation — is expressed entirely in the `auth.csrf` declaration.

## Tier 2 — scoped script slots

Some APIs can't be expressed as static templates: a header must be computed, a body
shaped, a response reduced. Tier 2 adds **small stringified-JS hooks** in three
declared slots. The slot name _is_ the capability — a script's scope determines what
it can do, and all slots are **pure compute: no network, ever**.

| Slot       | Signature                         | Runs when                                                    | Capability rules                                                                          |
| ---------- | --------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `headers`  | `(ctx) => Record<string, string>` | Before the executor sends the request                        | Return value is merged into request headers. No `fetch`/`XHR`/`import`.                   |
| `body`     | `(input, ctx) => unknown`         | When the request body is built                               | Return value becomes the JSON body. Input is the validated tool input. No network tokens. |
| `response` | `(json, ctx) => unknown`          | After a successful response, before the `returns` projection | Return value becomes the tool output (then projected). No network tokens.                 |

`ctx` carries executor-provided context (extracted tokens from `auth` sources, endpoint
metadata) — details to be pinned down when the executor is built.

Enforcement, in two layers (both best-effort, honest about their limits):

1. **Publish-time lint (hard gate):** the registry rejects tier-2 code containing
   `fetch`, `XMLHttpRequest`, `import`, `WebSocket`, etc., rejects anything over the
   size cap (1–2 KB per slot), and rejects minified/obfuscated code (see Trust model).
2. **Executor shadowing (defense in depth):** the executor evaluates slot code with
   those globals shadowed to throwing stubs.

This is **not a true sandbox** — same-realm JS cannot be sandboxed against a determined
author (prototype gadgets, `Function` constructor tricks, global pollution). The lint +
shadowing raises the bar and catches accidents and casual abuse; the _actual_ security
boundary is human curation plus the fact that even a fully malicious tier-2 script
cannot make network calls (the executor never gives it one) and can only corrupt output
for its own tool. ShadowRealm is the future hardening path — see Open questions.

## Tier 3 — full `evaluate`

A stringified async JS escape hatch for the long tail tier 1 + slots can't reach:
request signing, computed multipart payloads, multi-step token dances that don't fit
the `auth` declaration model.

- Executor-mediated: the script receives an executor-provided `request()` that is
  pinned to the declared `baseUrl` origin — it cannot fetch arbitrary hosts even here.
- **Flagged in the registry UI** (package card + install flow show "contains arbitrary
  code" prominently) and held to the highest curation bar.
- Registered tools from tier-3 packages should set `untrustedContentHint` where output
  is script-shaped.

> **This reverses a prior ground rule.** `AGENTS.md` and `packages/schema/src/steps.ts`
> both record "No `evaluate` step in v1 — arbitrary code execution in the user's
> logged-in page." That rule was written when execution meant _unmediated_ code in the
> page (Joakim's model). The reversal rationale: (1) DOM packages rot silently, pushing
> us toward API execution, and some real APIs need computed requests tier 1 cannot
> express; (2) the executor now mediates all network access behind an origin-pinned wall,
> which was not part of the original design; (3) explicit local installs pin a chosen
> `version_id`, so a malicious update never auto-propagates; (4) the declarative package
> content remains readable before that install. Tier 3 is gated behind tiers 1–2 in the build order and
> behind the MV3 spike (below) — it ships last, and only if the spike says it's shippable.

## GraphQL support

To the executor, GraphQL is just POST + a JSON body. Two things make it _first-class_
rather than merely possible:

1. **`errorPath: ["errors"]`** — GraphQL returns HTTP 200 with an `errors` array on
   failure. Without error-path handling every failure looks like success. With it,
   a 200 + non-empty `errors` is a tool error, surfaced to the agent.
2. **`documents` block** — captured real-world queries (Reddit's shreddit, GitHub's
   app queries) run hundreds of lines. Named static documents referenced as
   `@documents/name` keep packages readable. Variables bind from tool input via the
   same `{{param}}` templates — and because a variable whose whole value is one
   placeholder keeps its type, a `first: Int` binds as an Int rather than a string.

Third, **APQ (Automatic Persisted Queries)**, not yet supported: adding it would mean a
new schema field (there is no accepted field for it today) plus an executor
implementation, _once_, so no package author ever thinks about it:

```
send { extensions: { persistedQuery: { sha256Hash } } }
  → PersistedQueryNotFound
  → resend { query: <full document>, extensions: { ... } }
  → subsequent calls send hash only
```

Hash rotation on site deploys fails loudly (the server stops recognizing the hash, and
the full-query retry returns an error) and is exactly what the health canary is for —
the GraphQL analog of selector rot, but loud instead of silent.

**Out of scope for v1:** subscriptions / WebSockets. WebMCP tools are request/response;
a subscription has no place to stream to.

## Base URL origin enforcement

The single load-bearing invariant, so it gets its own section:

- `api.baseUrl` must use the package's declared domain or one of its subdomains.
  `urlPatterns` independently determine where a tool registers and do not need to
  cover `baseUrl`. Both relationships are validated at publish and again for stored
  data — a registry-side bug or legacy body must not be enough to break the invariant.
- The executor constructs the final URL itself from `baseUrl` + `path` + `query`;
  path/query templates are bound from _validated_ tool input, and the resolved URL is
  re-checked against `baseUrl`'s origin after binding (placeholder values cannot
  smuggle an origin change — `subreddit = "x HTTP/1.1\r\nHost:"` class attacks included).
- `auth` token sources fetch only from declared endpoints; tier-3 `request()` goes
  through the same check.
- Cookies/credentials are sent with the derived request (`credentials: "include"`
  equivalent), so tools act as the logged-in user only at the allowed `baseUrl` origin.

APIs on a package-domain subdomain such as `api.example.com` are allowed. The only
unrelated host is Hacker News's `https://hacker-news.firebaseio.com` for anonymous
`GET` reads with no auth, omitted cookies, and rejected redirects. Any additional
unrelated host needs an explicit future design because the invariant would get looser.

## Trust model

Tier 1 packages are readable declarative data, not code. Users inspect the tool
interface and explicitly install an exact version into local browser storage. A new
publish never changes that installed version; updating or rolling back is an explicit
local install choice.

## MV3 constraints + spike plan

Tiers 2–3 execute string code, and Manifest V3 forbids `unsafe-eval` in content scripts.
MAIN-world injection (a `<script>` tag or `chrome.scripting.executeScript` with a
string) is blocked by strict page CSP on exactly the sites we care about (GitHub's CSP
is the canonical wall). Candidate paths:

1. **`chrome.userScripts` API** — executes registered user scripts outside page CSP, but
   requires the `userScripts` permission _and_ a user-facing "Allow User Scripts"
   toggle in `chrome://extensions`. Real onboarding friction; acceptable if it's the
   only path.
2. **Packaged runner function** — ship a fixed, generic evaluator in the extension
   bundle (a tiny interpreter or a constrained function factory compiled at build time)
   and feed it the package's strings. Whether a sufficiently capable runner survives
   MV3 review and CSP is the open technical question.
3. **Script-tag injection** — dead on strict-CSP sites. Listed for completeness.

**Spike before building tiers 2–3.** The spike's job: execute a registry-delivered
string function in page context on GitHub (strict CSP) and on Reddit, under MV3, via
each viable path; document permissions friction and CSP behavior. Tier 1 needs **no**
code execution — the derived-call engine is ordinary extension code operating on package
data — so it is buildable today and is not blocked on the spike.

## Build order

1. ~~**`packages/schema`: zod for the `api` block + tests.**~~ **Done.** Endpoint/auth/
   document/projection schemas, placeholder↔inputSchema cross-validation (mirroring the
   `{{param}}` check in `tool.ts`), `baseUrl` host↔package-domain check.
2. ~~**Executor derived-call engine** (extension).~~ **Done**, except APQ: request
   construction, token sources (with TTL), `returns` projection, `errorPath` failure.
   APQ has no accepted schema field yet — adding it means a new field plus an
   executor implementation, not toggling an existing one. Output budgeting was
   dropped with `TOOL_OUTPUT_MAX`.
3. ~~**Reddit flagship package on tier 1 alone.**~~ **Done for REST** — reads plus
   `comment`/`vote` writes on the modhash token source. The planned GraphQL endpoint was
   **not** shipped: it needs APQ, which is step 2's remaining half.
4. **MV3 spike → scoped script slots** (tier 2), with publish-time lint in apps/web.
5. **Full `evaluate`** (tier 3) last — UI flagging, elevated curation flow.

## Open questions

- **Approval-before-publish vs open-publish + moderation — settled for tier 1.**
  Open-publish, per docs/DECISIONS.md 2026-07-24 (the package-install model): the unit
  of trust is a package a user chose to install, and a reviewer gate on individual tools
  stalls publishing as the corpus grows. What is still open is only the tier-2/3 review
  queue (`docs/BACKLOG.md`), which no code needs yet.
- **Chrome Web Store "no remote code execution" policy risk.** The registry delivers JS
  (tiers 2–3) into an extension context at runtime, which reads squarely like the
  policy's definition of remotely hosted code. Tampermonkey precedent: user-script
  managers survive in the store, apparently on the argument that the user explicitly
  installs each script. Our per-package explicit install + pinned versions resembles
  that, but the risk of a store rejection (or a later policy enforcement wave) is real
  and could kill tier-2/3 delivery — needs an answer before those tiers ship; possibly
  a store build with code tiers disabled.
- **ShadowRealm as future sandboxing.** `ShadowRealm.prototype.evaluate` gives a real
  realm boundary for tier-2/3 code (no shared prototypes, explicit callable membrane).
  It's the right long-term home for slot execution; browser support and MV3/CSP
  interaction are unverified — fold into the spike if time permits, otherwise track.
- **Output projection language — resolved: JMESPath.** `returns` was briefly a
  hand-rolled path-with-pickers grammar, replaced by
  `@jmespath-community/jmespath`. It buys filters and multi-select hashes we could not
  express, it is a written spec rather than our own invention, and — decisively — it
  compiles to an AST with no `eval` anywhere, which MV3's CSP requires. The two reads
  that are _locators_ rather than projections (`extract`, `errorPath`) deliberately did
  **not** move to JMESPath: they name one place in a document, an array says that
  exactly, and it keeps an expression evaluator out of the security-adjacent paths.
  Rejected alternatives and the `jsonpath-plus` exclusion: docs/DECISIONS.md 2026-07-27.
- **How does `ctx` compose?** What tier-2 slots and tier-3 scripts receive (tokens from
  `auth` sources, prior step outputs, endpoint metadata) is under-specified; pin down
  when the executor is built.
- **Additional unrelated API hosts.** A package-domain subdomain is supported, and the
  sole implemented exception is Hacker News's anonymous Firebase `GET` read API with no
  auth, omitted cookies, and rejected redirects. Real candidate sites with unrelated
  frontend/API hosts will pressure this — what's the loosest invariant we can live with?
- **Health canary for API packages.** Loud failures are only useful if something listens.
  The canary (out of scope per SPEC but reserved-for in the schema) should replay
  tier-1 calls against live sites; what runs it, and how do auth'd writes get canaried
  safely (a write canary posts real comments)?
- **`minEngine` bump policy — resolved.** Packages set `minEngine` to the engine level
  whose format they rely on. `ENGINE_VERSION` is `2`: level 2 adds the DOM observation
  executor. The
  extension refuses a too-new package _whole_ rather than
  registering tools it cannot run — `supportsPackageEngine`
  (`packages/engine/src/engine-gate.ts`), applied per package in `register-tools.ts`.
  What remains is UX, not correctness: the gate fires at registration, so a user can
  install a package their build cannot run and sees only a page-console warning.
