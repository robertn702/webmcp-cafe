import { search, type JSONValue } from "@jmespath-community/jmespath";
import {
  validateToolInput,
  type ApiAuthSource,
  type ApiBlock,
  type ApiExecution,
  type ApiEndpoint,
  type ToolDescriptor,
} from "@webmcp-today/schema";
import { mcpResult } from "./mcp-result.js";
import type { McpResult } from "./result.js";

// Tier-1 "derived-call engine": turns a package's declarative `api` block plus a
// tool's `execution: { mode: "api", endpoint }` into an actual HTTP request,
// performs it, and returns an McpResult. Ships zero package-authored code — it
// only operates on validated package data. See docs/api-execution-model.md.
//
// FETCH CONTEXT: these requests run in the CONTENT SCRIPT (page) context, NOT
// the background service worker. That is deliberate and load-bearing for calls
// to api.baseUrl:
//   - The page-context fetch is a *first-party same-site* request to the site's
//     own origin, so it carries ALL of the user's cookies — including
//     `SameSite=Strict`/`Lax` session cookies. That is what lets a tool act as
//     the logged-in user (Reddit's modhash write flow needs exactly this).
//   - A background/service-worker fetch is *cross-site* relative to the site's
//     cookies, so SameSite session cookies would be withheld and authenticated
//     writes would silently fail.
//   - The registry-lookup relay lives in the background because the registry is
//     a *different* origin from the page (page CSP `connect-src` would block
//     it). That reasoning is the opposite of primary-origin API execution: here the target IS
//     the page's origin, which `connect-src 'self'` and the site's own frontend
//     already permit — so there is no CSP problem to route around. An endpoint
//     may opt into a public cross-origin GET; that can still be blocked by the
//     page's connect-src/CORS, and always omits cookies.

const PLACEHOLDER_RE = /\{\{(\w+)\}\}/g;
/** A string that is EXACTLY one placeholder ("{{n}}", not "x{{n}}"). */
const WHOLE_PLACEHOLDER_RE = /^\{\{(\w+)\}\}$/;
const DOCUMENT_REF_RE = /^@documents\/(.+)$/;
const HACKER_NEWS_PUBLIC_API_ORIGIN = "https://hacker-news.firebaseio.com";

export interface DerivedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

function stringifyParam(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}

/** Interpolate {{param}} into a query/form/body string leaf (raw — the caller's
 *  encoder, e.g. URLSearchParams or JSON.stringify, handles escaping). */
function interpolateString(template: string, params: Record<string, unknown>): string {
  return template.replace(PLACEHOLDER_RE, (_, key: string) => stringifyParam(params[key]));
}

/** Exact query/form placeholders whose params were omitted do not produce a
 * field. `params` is null-prototype after validation, so call the intrinsic
 * rather than reading a method from it. */
function omitsExactPlaceholder(template: string, params: Record<string, unknown>): boolean {
  const whole = WHOLE_PLACEHOLDER_RE.exec(template);
  return whole !== null && !Object.prototype.hasOwnProperty.call(params, whole[1] ?? "");
}

/** Interpolate {{param}} into a regex pattern. Param values are quoted as
 * literal text; the package-authored template remains a raw JS regex. */
function interpolatePattern(template: string, params: Record<string, unknown>): string {
  return template.replace(PLACEHOLDER_RE, (_, key: string) =>
    stringifyParam(params[key]).replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&"),
  );
}

/** Interpolate {{param}} into a URL path — values are percent-encoded so a
 *  param can never inject a new path segment, query, fragment, or CRLF. */
function interpolatePath(template: string, params: Record<string, unknown>): string {
  return template.replace(PLACEHOLDER_RE, (_, key: string) =>
    encodeURIComponent(stringifyParam(params[key])),
  );
}

/** Recursively interpolate {{param}} on every string leaf of a body / graphql
 *  variables template; non-string leaves pass through unchanged.
 *
 *  A leaf that is EXACTLY one placeholder emits the RAW TYPED value, so a JSON
 *  body sends `{"count": 10}` rather than `{"count": "10"}` and a GraphQL
 *  `Int!` variable stays an Int. Anything else ("page {{n}}") concatenates as
 *  before. Only bodies need this: `query`/`form`/`path` are schema-typed as
 *  strings and their encoders stringify anyway.
 *
 *  A whole-string placeholder for a param that was not supplied yields
 *  `undefined`, which JSON.stringify drops from an object. That is deliberate —
 *  an absent optional should be absent, not `""`. */
export function interpolateDeep(value: unknown, params: Record<string, unknown>): unknown {
  if (typeof value === "string") {
    const whole = WHOLE_PLACEHOLDER_RE.exec(value);
    if (whole !== null) return params[whole[1] ?? ""];
    return interpolateString(value, params);
  }
  if (Array.isArray(value)) return value.map((item) => interpolateDeep(item, params));
  if (value !== null && typeof value === "object") {
    // Object.create(null): a template key of "__proto__" must not repoint this
    // object's prototype (a plain `{}` treats `out["__proto__"] = x` as a
    // prototype assignment, not an own property).
    const out: Record<string, unknown> = Object.create(null);
    for (const [key, item] of Object.entries(value)) out[key] = interpolateDeep(item, params);
    return out;
  }
  return value;
}

/** Walk a locator (object keys + numeric array indices) into a value. Returns
 *  undefined if any segment is missing. Used for `extract` and `errorPath` —
 *  the two reads that must name one place in a document and nothing more, so
 *  they take a segment array and never touch an expression evaluator. */
export function getByPath(value: unknown, path: string[]): unknown {
  let current: unknown = value;
  for (const segment of path) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index)) return undefined;
      current = current[index];
    } else if (typeof current === "object") {
      current = Reflect.get(current, segment);
    } else {
      return undefined;
    }
  }
  return current;
}

/** Is there a meaningful value here? Drives errorPath failure detection: an
 *  empty array/string/object (GraphQL's `errors: []`) is NOT an error; a
 *  populated one is. Primitives (number/boolean) count as present. */
export function isNonEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

/** Apply the endpoint's `returns` JMESPath projection, trimming the response
 *  for density and relevance (output itself is uncapped — docs/DECISIONS.md
 *  2026-07-24).
 *
 *  FAILS LOUDLY, by design. The previous hand-rolled grammar fell back to the
 *  whole response both when it couldn't parse the expression and when the path
 *  matched nothing, which is precisely the silent rot this execution model
 *  exists to replace. Now: a malformed expression or a runtime type error
 *  throws out of `search`, and a projection that resolves to nothing (JMESPath
 *  yields `null`) throws too — that is the API-shape-changed signal. An empty
 *  array is a legitimate "no results" and passes through untouched. */
export function applyProjection(value: JSONValue, returns?: string): JSONValue {
  if (returns === undefined || returns.length === 0) return value;
  const projected = search(value, returns);
  if (projected === null || projected === undefined) {
    throw new Error(
      `Projection "${returns}" matched nothing in the response — the API's shape has probably changed.`,
    );
  }
  return projected;
}

/** Resolve a GraphQL document: `@documents/name` -> the package-level document,
 *  inline documents pass through as-is. */
export function resolveDocument(api: ApiBlock, document: string): string {
  const match = DOCUMENT_REF_RE.exec(document);
  if (!match) return document;
  const name = match[1] ?? "";
  const resolved = api.documents?.[name];
  if (resolved === undefined) {
    throw new Error(`GraphQL document "@documents/${name}" is not defined in api.documents.`);
  }
  return resolved;
}

function assertSameOrigin(url: URL, baseOrigin: string): void {
  if (url.origin !== baseOrigin) {
    throw new Error(
      `Refusing request to ${url.origin} — only same-origin calls to ${baseOrigin} are allowed (api.baseUrl).`,
    );
  }
}

function endpointBaseUrl(api: ApiBlock, endpoint: ApiEndpoint): string {
  return endpoint.baseUrl ?? api.baseUrl;
}

function endpointUsesPrimaryOrigin(api: ApiBlock, endpoint: ApiEndpoint): boolean {
  return new URL(endpointBaseUrl(api, endpoint)).origin === new URL(api.baseUrl).origin;
}

function assertAuthSourcesUsePrimaryOrigin(api: ApiBlock, endpoint: ApiEndpoint): void {
  for (const authName of endpoint.auth ?? []) {
    const source = api.auth?.[authName];
    if (!source) throw new Error(`Auth source "${authName}" is not defined in api.auth.`);
    const sourceEndpoint = api.endpoints[source.source.endpoint];
    if (!sourceEndpoint) {
      throw new Error(
        `Auth source "${authName}" fetches from endpoint "${source.source.endpoint}", which is not defined.`,
      );
    }
    if (!endpointUsesPrimaryOrigin(api, sourceEndpoint)) {
      throw new Error(`Auth source "${authName}" must fetch from the primary api.baseUrl origin.`);
    }
  }
}

/** Construct the HTTP request for an endpoint from validated tool input. Pure
 *  and synchronous so it is unit-testable; performs the load-bearing
 *  same-origin re-check AFTER binding params. */
export function buildRequest(
  api: ApiBlock,
  endpoint: ApiEndpoint,
  params: Record<string, unknown>,
): DerivedRequest {
  const baseUrl = endpointBaseUrl(api, endpoint);
  const baseOrigin = new URL(baseUrl).origin;
  const url = new URL(interpolatePath(endpoint.path, params), baseUrl);
  if (endpoint.query) {
    for (const [key, template] of Object.entries(endpoint.query)) {
      if (omitsExactPlaceholder(template, params)) continue;
      url.searchParams.set(key, interpolateString(template, params));
    }
  }
  // Load-bearing: re-check the fully-resolved origin. A placeholder value or a
  // protocol-relative static path (e.g. "//evil.com/x") cannot smuggle a
  // different origin past this point.
  assertSameOrigin(url, baseOrigin);

  const headers: Record<string, string> = {};
  let body: string | undefined;

  if (endpoint.graphql) {
    const document = resolveDocument(api, endpoint.graphql.document);
    const variables = interpolateDeep(endpoint.graphql.variables ?? {}, params);
    body = JSON.stringify({ query: document, variables });
    headers["content-type"] = "application/json";
  } else if (endpoint.form) {
    const form = new URLSearchParams();
    for (const [key, template] of Object.entries(endpoint.form)) {
      if (omitsExactPlaceholder(template, params)) continue;
      form.set(key, interpolateString(template, params));
    }
    body = form.toString();
    headers["content-type"] = "application/x-www-form-urlencoded;charset=UTF-8";
  } else if (endpoint.body !== undefined) {
    body = JSON.stringify(interpolateDeep(endpoint.body, params));
    headers["content-type"] = "application/json";
  }

  // GET cannot carry a request body.
  if (endpoint.method === "GET") body = undefined;

  return { url: url.toString(), method: endpoint.method, headers, body };
}

export interface FetchOutcome {
  status: number;
  ok: boolean;
  text: string;
}

async function performFetch(
  request: DerivedRequest,
  headers: Record<string, string>,
  credentials: RequestCredentials,
  redirect: RequestRedirect,
): Promise<FetchOutcome> {
  const response = await fetch(request.url, {
    method: request.method,
    headers,
    body: request.body,
    credentials,
    redirect,
  });
  return { status: response.status, ok: response.ok, text: await response.text() };
}

interface CachedToken {
  value: string;
  expiresAt: number;
}

/** Tokens whose source declares `ttlSeconds`, cached ACROSS tool calls — the
 *  per-invocation map only dedupes within a single call, which is why every
 *  Reddit write used to re-fetch the modhash first. A source WITHOUT
 *  `ttlSeconds` is never stored here (Airbyte's default: refresh every
 *  request), so opting in is explicit.
 *
 *  Keyed by origin + source name + the RESOLVED fetch URL + the extraction
 *  spec (locator or interpolated pattern). The resolved URL matters: a source
 *  whose endpoint is parameterized (HN's /item?id={{itemId}}) yields a
 *  DIFFERENT token per param value, so the template path alone would hand
 *  item A's vote token to a vote on item B. */
const persistentTokenCache = new Map<string, CachedToken>();

function tokenCacheKey(
  api: ApiBlock,
  name: string,
  source: ApiAuthSource,
  resolvedUrl: string,
  resolvedPattern?: string,
): string {
  return [
    api.baseUrl,
    name,
    resolvedUrl,
    ...(source.source.extract ?? []),
    resolvedPattern ?? "",
  ].join("\u0000");
}

/** Drop every cross-call token. For tests; nothing in production needs it. */
export function clearAuthTokenCache(): void {
  persistentTokenCache.clear();
}

/** A resolved auth token, ready to inject where its source's `sendAs` says. */
interface ResolvedToken {
  in: "header" | "form" | "query";
  name: string;
  value: string;
}

/** Extract the token from a fetched auth-source response: a `pattern` source
 *  regexes the raw text (HTML token sources); an `extract` source walks a
 *  locator into the parsed JSON (after the source endpoint's `stripPrefix` is
 *  removed). Both fail loudly on no token — a silent empty credential would
 *  surface later as an opaque site error. */
function extractToken(
  source: ApiAuthSource,
  name: string,
  text: string,
  params: Record<string, unknown>,
  stripPrefix?: string,
): string {
  if (source.source.pattern !== undefined) {
    const resolvedPattern = interpolatePattern(source.source.pattern, params);
    const match = new RegExp(resolvedPattern).exec(text);
    const token = match?.[1];
    if (token === undefined || token === "") {
      throw new Error(
        `Auth source "${name}" pattern matched nothing — the page shape has probably changed (or the session is logged out).`,
      );
    }
    return token;
  }
  if (source.source.extract === undefined) {
    // Unreachable post-validation (exactly one extraction mode is enforced);
    // throw rather than guess if an unvalidated block ever gets here.
    throw new Error(`Auth source "${name}" declares no extraction mode.`);
  }
  let json: unknown;
  try {
    json = parseJson(text, stripPrefix);
  } catch {
    throw new Error(`Auth source "${name}" did not return JSON.`);
  }
  const token = getByPath(json, source.source.extract);
  if (token === undefined || token === null || token === "") {
    throw new Error(
      `Auth source "${name}" yielded no token at "${source.source.extract.join(".")}".`,
    );
  }
  return String(token);
}

/** Resolve one named auth token source (e.g. Reddit's modhash): fetch its
 *  source endpoint, extract the token, and return it with its injection
 *  target. Two layers of caching — the per-call map (one fetch per source per
 *  tool call, always) and the TTL cache above (only when the source opts in). */
async function resolveAuthToken(
  api: ApiBlock,
  name: string,
  params: Record<string, unknown>,
  cache: Map<string, string>,
): Promise<ResolvedToken> {
  const source = api.auth?.[name];
  if (!source) throw new Error(`Auth source "${name}" is not defined in api.auth.`);
  const sendAs = source.sendAs;

  const cached = cache.get(name);
  if (cached !== undefined) return { in: sendAs.in, name: sendAs.name, value: cached };

  const sourceEndpoint = api.endpoints[source.source.endpoint];
  if (!sourceEndpoint) {
    throw new Error(
      `Auth source "${name}" fetches from endpoint "${source.source.endpoint}", which is not defined.`,
    );
  }
  if (!endpointUsesPrimaryOrigin(api, sourceEndpoint)) {
    throw new Error(`Auth source "${name}" must fetch from the primary api.baseUrl origin.`);
  }

  const ttlMs = source.ttlSeconds === undefined ? 0 : source.ttlSeconds * 1000;
  const request = buildRequest(api, sourceEndpoint, params);
  const resolvedPattern =
    source.source.pattern === undefined
      ? undefined
      : interpolatePattern(source.source.pattern, params);
  const key = tokenCacheKey(api, name, source, request.url, resolvedPattern);
  if (ttlMs > 0) {
    const stored = persistentTokenCache.get(key);
    if (stored !== undefined && stored.expiresAt > Date.now()) {
      cache.set(name, stored.value);
      return { in: sendAs.in, name: sendAs.name, value: stored.value };
    }
  }

  const outcome = await performFetch(request, request.headers, "include", "error");
  if (!outcome.ok) {
    throw new Error(`Auth source "${name}" request failed: HTTP ${outcome.status}.`);
  }
  const value = extractToken(source, name, outcome.text, params, sourceEndpoint.stripPrefix);
  cache.set(name, value);
  if (ttlMs > 0) persistentTokenCache.set(key, { value, expiresAt: Date.now() + ttlMs });
  return { in: sendAs.in, name: sendAs.name, value };
}

/** JSON.parse returns `any`. This is the one place that narrows it to the
 *  JSONValue the projection engine's types want — sound by construction, since
 *  JSON.parse cannot produce anything else, and it stops the `any` at this
 *  line instead of letting it spread. Applies the endpoint's `stripPrefix`
 *  first (Google's anti-XSSI `)]}'` on Maps/Gmail) — only when the body
 *  actually starts with it, so a site dropping its own prefix is a no-op
 *  rather than a newly-failing package. */
function parseJson(text: string, stripPrefix?: string): JSONValue {
  const body =
    stripPrefix !== undefined && text.startsWith(stripPrefix)
      ? text.slice(stripPrefix.length)
      : text;
  return JSON.parse(body);
}

/** Interpret a completed response: HTTP status, then `errorPath` (GraphQL
 *  200-with-errors default to ["errors"]), then `returns` projection.
 *  Throws on failure so the outer wrapper formats a single error result. */
export function handleResponse(endpoint: ApiEndpoint, outcome: FetchOutcome): McpResult {
  let json: JSONValue | undefined;
  try {
    json = parseJson(outcome.text, endpoint.stripPrefix);
  } catch {
    json = undefined;
  }

  if (json === undefined) {
    if (!outcome.ok) throw new Error(`HTTP ${outcome.status}: ${outcome.text.slice(0, 200)}`);
    return mcpResult(outcome.text);
  }

  if (!outcome.ok) {
    throw new Error(`HTTP ${outcome.status}: ${JSON.stringify(json).slice(0, 500)}`);
  }

  const errorPath = endpoint.errorPath ?? (endpoint.graphql ? ["errors"] : undefined);
  if (errorPath !== undefined) {
    const payload = getByPath(json, errorPath);
    if (isNonEmpty(payload)) {
      throw new Error(
        `API error at "${errorPath.join(".")}": ${JSON.stringify(payload).slice(0, 500)}`,
      );
    }
  }

  const projected = applyProjection(json, endpoint.returns);
  return mcpResult(typeof projected === "string" ? projected : JSON.stringify(projected));
}

/** The subset of a package's ToolDescriptor that executeApiTool actually
 *  reads: `inputSchema` to validate params, `annotations` for the
 *  destructiveHint confirm gate, and `execution` for the endpoint binding.
 *  The engine never touches `description` (that's UI/registration-only), so
 *  callers (and tests) don't have to fabricate one just to execute a tool. */
export type ApiToolDescriptor = Omit<
  Pick<ToolDescriptor, "name" | "inputSchema" | "annotations" | "execution">,
  "execution"
> & { execution: ApiExecution };

export async function executeApiTool(
  tool: ApiToolDescriptor,
  api: ApiBlock,
  params: Record<string, unknown>,
): Promise<McpResult> {
  try {
    return await executeApiToolInner(tool, api, params);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[webmcp-today] API tool "${tool.name}" failed:`, err);
    return mcpResult(`Error executing "${tool.name}": ${msg}`);
  }
}

async function executeApiToolInner(
  tool: ApiToolDescriptor,
  api: ApiBlock,
  params: Record<string, unknown>,
): Promise<McpResult> {
  const { name: toolName, annotations } = tool;
  const endpointName = tool.execution.endpoint;
  const endpoint = api.endpoints[endpointName];
  if (!endpoint) throw new Error(`Endpoint "${endpointName}" is not defined in api.endpoints.`);
  if (!endpointUsesPrimaryOrigin(api, endpoint) && endpoint.method !== "GET") {
    throw new Error(`Cross-origin endpoint "${endpointName}" must use GET.`);
  }
  if (
    !endpointUsesPrimaryOrigin(api, endpoint) &&
    new URL(endpointBaseUrl(api, endpoint)).origin !== HACKER_NEWS_PUBLIC_API_ORIGIN
  ) {
    throw new Error(
      `Cross-origin endpoint "${endpointName}" must use ${HACKER_NEWS_PUBLIC_API_ORIGIN}.`,
    );
  }
  if (!endpointUsesPrimaryOrigin(api, endpoint) && (endpoint.auth?.length ?? 0) > 0) {
    throw new Error(`Cross-origin endpoint "${endpointName}" must not use auth sources.`);
  }
  assertAuthSourcesUsePrimaryOrigin(api, endpoint);

  // Validate BEFORE any side effect below (confirm dialog, auth-source fetch,
  // request interpolation, the tool's own fetch) — an agent that sends bad
  // input must never trigger a confirmation prompt or touch the network.
  const validation = validateToolInput(tool.inputSchema, params);
  if (!validation.success) {
    // Report every issue (not just the first) so an agent can fix its call in
    // one round trip instead of rediscovering failures one at a time.
    const summary = validation.issues
      .map(
        (issue) => `${issue.path.length > 0 ? issue.path.join(".") : "(root)"}: ${issue.message}`,
      )
      .join("; ");
    throw new Error(`Invalid input: ${summary}`);
  }
  // Object.create(null) (see validateToolInput): a declared property named
  // "__proto__" lands as an ordinary own property here, never a prototype
  // reassignment, before this data reaches interpolation/request-building.
  const validParams = validation.data;

  // Per-spec courtesy confirm for tools flagged destructive (mirrors the DOM
  // executor). Guarded so the engine stays callable outside a browser (tests).
  if (annotations?.destructiveHint === true && typeof window !== "undefined") {
    if (!window.confirm(`Allow "${toolName}" to call the site API and make changes?`)) {
      return mcpResult(`Tool "${toolName}" cancelled by user.`);
    }
  }

  // Resolve auth token sources first, caching per source-name for this call.
  const tokenCache = new Map<string, string>();
  const tokens: ResolvedToken[] = [];
  for (const authName of endpoint.auth ?? []) {
    tokens.push(await resolveAuthToken(api, authName, validParams, tokenCache));
  }

  const request = buildRequest(api, endpoint, validParams);
  const credentials: RequestCredentials = endpointUsesPrimaryOrigin(api, endpoint)
    ? "include"
    : "omit";
  const redirect: RequestRedirect = "error";
  // Inject each token where its source's sendAs points: header, query param,
  // or an extra urlencoded form field appended to the built body.
  let url = request.url;
  let body = request.body;
  const headers: Record<string, string> = { ...request.headers };
  for (const token of tokens) {
    if (token.in === "header") {
      headers[token.name] = token.value;
    } else if (token.in === "query") {
      const parsed = new URL(url);
      parsed.searchParams.set(token.name, token.value);
      url = parsed.toString();
    } else {
      // form — schema validation already requires a form body for this
      // pairing; the guard is for unvalidated blocks reaching the executor.
      if (body === undefined || endpoint.form === undefined) {
        throw new Error(
          `Auth token "${token.name}" targets a form field but endpoint "${endpointName}" has no form body.`,
        );
      }
      // Re-parse and re-serialize rather than string-appending: the body was
      // built by URLSearchParams (spaces as `+`), and routing the token
      // through the same encoder keeps the whole payload one encoding.
      const form = new URLSearchParams(body);
      form.set(token.name, token.value);
      body = form.toString();
    }
  }

  const outcome = await performFetch(
    { url, method: request.method, headers, body },
    headers,
    credentials,
    redirect,
  );
  return handleResponse(endpoint, outcome);
}
