import { compile } from "@jmespath-community/jmespath";
import { z } from "zod";
import type { ToolDescriptor } from "./tool.js";
import { TEMPLATE_RE, unknownPlaceholders } from "./templates.js";
import { hostnameWithinDomain } from "./url-matching.js";

// Tier-1 API execution model — a package declares a site's HTTP surface as data
// and the executor derives the request. See docs/api-execution-model.md.
// This block is package-level (next to tools[]); tools bind to an endpoint by
// name via the tool's `endpoint` field. Reference integrity + same-origin
// baseUrl + {{param}} placeholder checks live in collectApiIssues (run from the
// package-level superRefine, because they need the sibling tools[]/urlPatterns).

const NAME_MAX = 64;
/** One key (or numeric array index) in a locator path. */
const PATH_SEGMENT_MAX = 200;
/** Segments in a locator path — deep enough for any real payload. */
const PATH_SEGMENTS_MAX = 20;
/** `returns` is JMESPath, whose multi-select hash spells out both sides of
 * every field (`{id: id, title: title}`), so it needs a larger ceiling than a
 * locator path. */
const PROJECTION_MAX = 1000;
/** Captured GraphQL queries run hundreds of lines; keep the ceiling generous. */
const DOCUMENT_MAX = 100_000;

const endpointName = z.string().min(1).max(NAME_MAX);

const httpsUrlSchema = z
  .string()
  .min(1)
  .max(2048)
  .refine((value) => {
    try {
      return new URL(value).protocol === "https:";
    } catch {
      return false;
    }
  }, "baseUrl must be a valid https:// URL");

const HACKER_NEWS_PUBLIC_API_ORIGIN = "https://hacker-news.firebaseio.com";

/** A **locator**: the object keys / array indices naming ONE place in a JSON
 * document, e.g. `["data", "modhash"]`. An array rather than a dot string so a
 * key that itself contains a dot is unambiguous, and so the two
 * security-adjacent reads (token extraction, error detection) need no
 * expression evaluator at all. Reshaping is `returns`, which is a different
 * job and a different type. */
const locatorPath = z.array(z.string().min(1).max(PATH_SEGMENT_MAX)).min(1).max(PATH_SEGMENTS_MAX);

/** A named credential-acquisition flow, e.g. Reddit's modhash dance: fetch an
 * endpoint, extract a token from its response, resend it on the write call. */
function quantifierAt(
  pattern: string,
  start: number,
): { end: number; repeats: boolean; variableWidth: boolean; unbounded: boolean } | null {
  const result = (end: number, repeats: boolean, variableWidth: boolean, unbounded: boolean) => ({
    end: pattern[end] === "?" ? end + 1 : end,
    repeats,
    variableWidth,
    unbounded,
  });
  const character = pattern[start];
  if (character === "*" || character === "+") return result(start + 1, true, true, true);
  if (character === "?") return result(start + 1, false, true, false);
  if (character !== "{") return null;

  let end = start + 1;
  if (end >= pattern.length || !/[0-9]/.test(pattern[end] ?? "")) return null;
  while (/[0-9]/.test(pattern[end] ?? "")) end += 1;

  const minimum = Number(pattern.slice(start + 1, end));
  if (pattern[end] === "}") return result(end + 1, minimum > 1, false, false);
  if (pattern[end] !== ",") return null;
  end += 1;
  if (pattern[end] === "}") return result(end + 1, true, true, true);
  if (!/[0-9]/.test(pattern[end] ?? "")) return null;

  const maximumStart = end;
  while (/[0-9]/.test(pattern[end] ?? "")) end += 1;
  if (pattern[end] !== "}") return null;
  const maximum = Number(pattern.slice(maximumStart, end));
  return result(end + 1, maximum > 1, minimum !== maximum, false);
}

/** Reject nested repetitions that remain unbounded. This is a deliberately
 * narrow structural screen, not a complete regex-safety proof. */
function hasNestedVariableRepeat(pattern: string): boolean {
  const groups: { hasUnboundedRepeat: boolean; hasVariableWidth: boolean }[] = [
    { hasUnboundedRepeat: false, hasVariableWidth: false },
  ];

  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (character === "[") {
      index += 1;
      while (index < pattern.length) {
        if (pattern[index] === "\\") {
          index += 1;
        } else if (pattern[index] === "]") {
          break;
        }
        index += 1;
      }
      continue;
    }
    if (character === "(") {
      groups.push({ hasUnboundedRepeat: false, hasVariableWidth: false });
      // Skip the leading `?` in non-capturing, lookaround, and named groups so
      // it is not mistaken for a quantifier.
      if (pattern[index + 1] === "?") index += 1;
      continue;
    }

    if (character === ")") {
      const group = groups.pop();
      const quantifier = quantifierAt(pattern, index + 1);
      if (
        (group?.hasUnboundedRepeat && quantifier?.repeats) ||
        (group?.hasVariableWidth && quantifier?.unbounded)
      ) {
        return true;
      }
      if (group !== undefined || quantifier !== null) {
        const parent = groups.at(-1);
        if (parent !== undefined) {
          parent.hasUnboundedRepeat ||=
            (group?.hasUnboundedRepeat ?? false) || quantifier?.unbounded === true;
          parent.hasVariableWidth ||=
            (group?.hasVariableWidth ?? false) || quantifier?.variableWidth === true;
        }
      }
      if (quantifier !== null) {
        index = quantifier.end - 1;
      }
      continue;
    }

    const quantifier = quantifierAt(pattern, index);
    if (quantifier !== null) {
      if (!quantifier.variableWidth) {
        index = quantifier.end - 1;
        continue;
      }
      const group = groups.at(-1);
      if (group !== undefined) {
        group.hasUnboundedRepeat ||= quantifier.unbounded;
        group.hasVariableWidth ||= quantifier.variableWidth;
      }
      index = quantifier.end - 1;
    }
  }

  return false;
}

function validateAuthPattern(pattern: string): string | null {
  const staticPattern = pattern.replace(TEMPLATE_RE, "webmcp_placeholder");
  try {
    new RegExp(staticPattern);
    const captureProbe = new RegExp(`(?:${staticPattern})|`).exec("");
    if (captureProbe === null || captureProbe.length < 2) {
      return "pattern must define capture group 1 for the token";
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return `pattern must be valid JavaScript regex syntax: ${detail}`;
  }
  if (hasNestedVariableRepeat(staticPattern)) {
    return "pattern must not nest an unbounded repeat inside another repeated group or variable-width group";
  }
  return null;
}

export const apiAuthSourceSchema = z.strictObject({
  source: z
    .strictObject({
      // Endpoint (by name) to fetch the token from.
      endpoint: endpointName,
      // Locator into the JSON response, e.g. ["data", "modhash"].
      extract: locatorPath.optional(),
      // Regex (JS syntax) matched against the RAW response text — for token
      // sources that return HTML rather than JSON (Hacker News serves its hmac
      // as a hidden form input, its vote token inside an href). Capture group
      // 1 is the token; no match is a loud failure. May carry {{param}}
      // placeholders (e.g. a per-item id in a vote URL); their values are
      // regex-escaped before compiling, so they match literal text.
      pattern: z
        .string()
        .min(1)
        .max(500)
        .superRefine((pattern, ctx) => {
          const error = validateAuthPattern(pattern);
          if (error !== null) ctx.addIssue({ code: "custom", message: error });
        })
        .optional(),
    })
    .superRefine((src, ctx) => {
      // Exactly one extraction mode. Zero = no way to get a token; two = the
      // executor picks one and the other silently rots.
      if ((src.extract === undefined) === (src.pattern === undefined)) {
        ctx.addIssue({
          code: "custom",
          message: "Declare exactly one of extract (JSON locator) or pattern (raw-text regex).",
          path: src.extract === undefined ? ["extract"] : ["pattern"],
        });
      }
    }),
  sendAs: z.strictObject({
    // Where the token is injected: a request header (Reddit's X-Modhash), a
    // form field (HN's hmac), or a query param (HN's vote auth). The {in,
    // name} axis is the one four independent teams converged on (OpenAPI `in`,
    // Airbyte `inject_into`, Higress `position`, FastMCP `location`).
    in: z.enum(["header", "form", "query"]),
    name: z.string().min(1).max(200),
  }),
  /** How long a fetched token stays usable, in seconds. OMITTED = re-fetch on
   * every request, which is Airbyte's default and the safe one. Seconds rather
   * than an ISO-8601 duration ("PT1H"): a duration string needs a hand-written
   * parser plus a regex refine that has to agree with it, and its only payoff
   * is familiarity in a format nothing but our executor reads. Capped at 86400
   * (24h) — a token cached longer than that is a stale-credential risk, not a
   * legitimate performance optimization. */
  ttlSeconds: z.int().positive().max(86400).optional(),
});

/** A GraphQL operation. `document` is opaque — either an inline query or a
 * "@documents/name" reference into the package-level `documents` block. It is
 * NEVER template-scanned; only `variables` bind {{param}} from tool input. */
export const apiGraphqlSchema = z.strictObject({
  document: z.string().min(1).max(DOCUMENT_MAX),
  variables: z.record(z.string(), z.unknown()).optional(),
});

/** Request body kinds an endpoint may declare. Exactly one carries the body,
 * so declaring two is always an authoring mistake (see the superRefine). */
const BODY_KINDS = ["graphql", "form", "body"] as const;

export const apiEndpointSchema = z
  .strictObject({
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
    /** An anonymous public-read origin. Cross-origin calls are limited to GET
     * without auth by package-level validation. */
    baseUrl: httpsUrlSchema.optional(),
    path: z
      .string()
      .min(1)
      .max(2048)
      .refine(
        (path) =>
          path.startsWith("/") &&
          !path.includes("//") &&
          !path.includes("\\") &&
          !path.includes("?") &&
          !path.includes("#") &&
          !path.split("/").some((segment) => segment === "." || segment === ".."),
        "path must begin with exactly one '/', contain no '//', no '.'/'..' segments, and contain no URL, backslash, query, or fragment",
      ),
    query: z.record(z.string(), z.string()).optional(),
    // Opaque body template; string leaves may carry {{param}} placeholders.
    body: z.unknown().optional(),
    form: z.record(z.string(), z.string()).optional(),
    // Response projection (JMESPath — https://jmespath.site). Compiled here so
    // a malformed expression is rejected at publish time rather than failing
    // in every user's browser, one call at a time.
    returns: z
      .string()
      .min(1)
      .max(PROJECTION_MAX)
      .superRefine((expression, ctx) => {
        try {
          compile(expression);
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          ctx.addIssue({
            code: "custom",
            message: `returns must be a valid JMESPath expression: ${detail}`,
          });
        }
      })
      .optional(),
    // Locator for an error payload in a 200 body (GraphQL ["errors"], Reddit
    // ["json", "errors"]); a non-empty value there = tool failure.
    errorPath: locatorPath.optional(),
    // Literal response-body prefix to strip BEFORE JSON parsing — Google's
    // anti-XSSI marker `)]}'` is the canonical case (Maps, Gmail). A literal
    // string rather than a boolean so the executor carries no site-specific
    // constants. Stripped only when present: a site that drops its own prefix
    // must not break a package that was already working.
    stripPrefix: z.string().min(1).max(50).optional(),
    graphql: apiGraphqlSchema.optional(),
    // Names of auth token sources to attach to this call.
    auth: z.array(endpointName).max(10).optional(),
  })
  .superRefine((endpoint, ctx) => {
    // At most one body kind. The executor resolves graphql > form > body by
    // precedence, so an endpoint declaring two publishes clean and then sends
    // something its author never asked for — a silent wrong answer, which is
    // the one failure mode this format exists to avoid.
    const declared = BODY_KINDS.filter((kind) => endpoint[kind] !== undefined);
    if (declared.length > 1) {
      ctx.addIssue({
        code: "custom",
        message: `Endpoint declares more than one request body (${declared.join(", ")}); declare at most one.`,
        path: [declared[1] ?? "body"],
      });
    }
    if (endpoint.method === "GET" && declared.length > 0) {
      ctx.addIssue({
        code: "custom",
        message: "GET endpoints cannot declare body, form, or graphql",
        path: [declared[0] ?? "body"],
      });
    }
  });

export const apiBlockSchema = z.strictObject({
  baseUrl: httpsUrlSchema,
  auth: z.record(z.string(), apiAuthSourceSchema).optional(),
  // DOM-only packages retain the required api block for now. Package-level
  // cross-validation still rejects every API tool whose endpoint is absent.
  endpoints: z.record(z.string(), apiEndpointSchema),
  // Opaque named static GraphQL documents, referenced as "@documents/name".
  // NEVER template-scanned.
  documents: z.record(z.string(), z.string().min(1).max(DOCUMENT_MAX)).optional(),
});

export type ApiAuthSource = z.infer<typeof apiAuthSourceSchema>;
export type ApiEndpoint = z.infer<typeof apiEndpointSchema>;
export type ApiBlock = z.infer<typeof apiBlockSchema>;

const DOCUMENT_REF_RE = /^@documents\/(.+)$/;

export interface ApiValidationIssue {
  message: string;
  path: (string | number)[];
}

/** What collectApiIssues needs from a package: the api block plus the sibling
 * fields its references are checked against. Structurally satisfied by both the
 * full create-package shape and the publish-version subset. */
export interface ApiValidationTarget {
  /** Omitted only by the generic version-body schema; routes supply it. */
  domain?: string;
  urlPatterns: string[];
  tools: ToolDescriptor[];
  api?: ApiBlock;
}

/** Scan every string leaf of an arbitrary template value (body / graphql
 * variables) for {{param}} placeholders not present in `props`. */
function scanTemplateValue(
  value: unknown,
  props: string[],
  path: (string | number)[],
  issues: ApiValidationIssue[],
): void {
  if (typeof value === "string") {
    for (const name of unknownPlaceholders(value, props)) {
      issues.push({
        message: `Template variable "{{${name}}}" has no matching inputSchema property. Available: ${props.join(", ") || "(none)"}`,
        path,
      });
    }
  } else if (Array.isArray(value)) {
    value.forEach((item, i) => scanTemplateValue(item, props, [...path, i], issues));
  } else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      scanTemplateValue(item, props, [...path, key], issues);
    }
  }
}

/** Cross-validate an `api` block against the package's tools and urlPatterns.
 * Pure: returns issues instead of pushing to a zod ctx, so package.ts can wire
 * it into a superRefine without ctx-typing gymnastics. */
export function collectApiIssues(target: ApiValidationTarget): ApiValidationIssue[] {
  const issues: ApiValidationIssue[] = [];
  const { api, tools } = target;

  // 1. Tool endpoint bindings resolve; 2. their placeholders resolve.
  for (const [i, tool] of tools.entries()) {
    const endpointName = tool.execution?.mode === "api" ? tool.execution.endpoint : undefined;
    if (endpointName === undefined) continue;
    const endpoint = api?.endpoints[endpointName];
    if (!endpoint) {
      issues.push({
        message: `Tool "${tool.name}" binds to endpoint "${endpointName}", which is not defined in api.endpoints.`,
        path: ["tools", i, "execution", "endpoint"],
      });
      continue;
    }
    const props = Object.keys(tool.inputSchema.properties);
    const base = ["api", "endpoints", endpointName];
    scanTemplateValue(endpoint.path, props, [...base, "path"], issues);
    if (endpoint.query) scanTemplateValue(endpoint.query, props, [...base, "query"], issues);
    if (endpoint.form) scanTemplateValue(endpoint.form, props, [...base, "form"], issues);
    if (endpoint.body !== undefined) {
      scanTemplateValue(endpoint.body, props, [...base, "body"], issues);
    }
    // graphql.document is opaque; only variables are template-scanned.
    if (endpoint.graphql?.variables) {
      scanTemplateValue(
        endpoint.graphql.variables,
        props,
        [...base, "graphql", "variables"],
        issues,
      );
    }

    // Auth-token sources ride along on the tool's call: their fetch endpoint's
    // templates and their extraction `pattern` bind the SAME tool params, so
    // they are scanned against this tool's props too. (The source endpoint is
    // typically not tool-bound itself, so the main scan above never sees it.)
    for (const authRef of endpoint.auth ?? []) {
      const src = api?.auth?.[authRef];
      if (!src) continue; // missing ref — flagged by the reference check below.
      const srcEndpoint = api?.endpoints[src.source.endpoint];
      if (srcEndpoint) {
        const srcBase = ["api", "endpoints", src.source.endpoint];
        scanTemplateValue(srcEndpoint.path, props, [...srcBase, "path"], issues);
        if (srcEndpoint.query) {
          scanTemplateValue(srcEndpoint.query, props, [...srcBase, "query"], issues);
        }
      }
      if (src.source.pattern !== undefined) {
        scanTemplateValue(
          src.source.pattern,
          props,
          ["api", "auth", authRef, "source", "pattern"],
          issues,
        );
      }
    }
  }

  if (!api) return issues;

  const authNames = new Set(Object.keys(api.auth ?? {}));
  const endpointNames = new Set(Object.keys(api.endpoints));
  const documentNames = new Set(Object.keys(api.documents ?? {}));

  // 3. Endpoint auth refs exist in api.auth; 4. @documents refs exist;
  //    4b. A form-field token needs a form body to land in — anything else
  //    sends a request missing its credential, a silent auth failure.
  for (const [name, endpoint] of Object.entries(api.endpoints)) {
    (endpoint.auth ?? []).forEach((ref, ai) => {
      if (!authNames.has(ref)) {
        issues.push({
          message: `Endpoint "${name}" references auth source "${ref}", which is not defined in api.auth.`,
          path: ["api", "endpoints", name, "auth", ai],
        });
        return;
      }
      if (api.auth?.[ref]?.sendAs.in === "form" && endpoint.form === undefined) {
        issues.push({
          message: `Endpoint "${name}" attaches form-token source "${ref}" but declares no form body.`,
          path: ["api", "endpoints", name, "auth", ai],
        });
      }
    });
    const doc = endpoint.graphql?.document;
    const docMatch = doc === undefined ? null : DOCUMENT_REF_RE.exec(doc);
    if (docMatch && !documentNames.has(docMatch[1] ?? "")) {
      issues.push({
        message: `Endpoint "${name}" references document "${doc}", which is not defined in api.documents.`,
        path: ["api", "endpoints", name, "graphql", "document"],
      });
    }
  }

  // An endpoint may use a separate origin only for an anonymous public read.
  // Keep session cookies and extracted credentials on the visible package's
  // origin; otherwise an installed package could exfiltrate them.
  let primaryOrigin: string | null = null;
  try {
    primaryOrigin = new URL(api.baseUrl).origin;
  } catch {
    // The baseUrl field carries the validation error; do not turn safeParse
    // into a thrown exception while checking dependent cross-field rules.
  }
  for (const [name, endpoint] of Object.entries(api.endpoints)) {
    if (endpoint.baseUrl === undefined || primaryOrigin === null) continue;
    let endpointOrigin: string | null = null;
    try {
      endpointOrigin = new URL(endpoint.baseUrl).origin;
    } catch {
      continue;
    }
    if (endpointOrigin === primaryOrigin) continue;
    if (endpointOrigin !== HACKER_NEWS_PUBLIC_API_ORIGIN) {
      issues.push({
        message: `Cross-origin endpoint "${name}" must use ${HACKER_NEWS_PUBLIC_API_ORIGIN}.`,
        path: ["api", "endpoints", name, "baseUrl"],
      });
    }
    if (endpoint.method !== "GET") {
      issues.push({
        message: `Cross-origin endpoint "${name}" must use GET.`,
        path: ["api", "endpoints", name, "method"],
      });
    }
    if (endpoint.auth !== undefined && endpoint.auth.length > 0) {
      issues.push({
        message: `Cross-origin endpoint "${name}" must not use auth sources.`,
        path: ["api", "endpoints", name, "auth"],
      });
    }
  }

  // 5. Auth sources fetch from a defined endpoint (reference integrity).
  for (const [name, src] of Object.entries(api.auth ?? {})) {
    if (!endpointNames.has(src.source.endpoint)) {
      issues.push({
        message: `Auth source "${name}" fetches from endpoint "${src.source.endpoint}", which is not defined in api.endpoints.`,
        path: ["api", "auth", name, "source", "endpoint"],
      });
      continue;
    }
    const sourceEndpoint = api.endpoints[src.source.endpoint];
    let sourceOrigin: string | null = null;
    try {
      sourceOrigin =
        sourceEndpoint?.baseUrl === undefined
          ? primaryOrigin
          : new URL(sourceEndpoint.baseUrl).origin;
    } catch {
      continue;
    }
    if (primaryOrigin !== null && sourceOrigin !== primaryOrigin) {
      issues.push({
        message: `Auth source "${name}" must fetch from the primary api.baseUrl origin.`,
        path: ["api", "auth", name, "source", "endpoint"],
      });
    }
  }

  // 6. Same-origin: baseUrl host must stay within the visible package domain
  // when known. Generic version bodies lack the parent package domain; the
  // publish route validates that relationship with publishVersionSchemaForDomain.
  let baseHost: string | null = null;
  try {
    baseHost = new URL(api.baseUrl).hostname.toLowerCase();
  } catch {
    baseHost = null; // invalid URL already flagged by the baseUrl field refine.
  }
  if (baseHost !== null && target.domain !== undefined) {
    if (!hostnameWithinDomain(baseHost, target.domain)) {
      issues.push({
        message: `api.baseUrl host "${baseHost}" must be "${target.domain}" or one of its subdomains (same-origin enforcement).`,
        path: ["api", "baseUrl"],
      });
    }
  }

  return issues;
}
