import { z } from "zod";
import { apiBlockSchema, collectApiIssues, type ApiValidationTarget } from "./api.js";
import { toolDescriptorSchema } from "./tool.js";
import {
  domainCoveredByPatterns,
  isRegistrableHostname,
  parseUrlPattern,
  urlPatternsWithinDomain,
} from "./url-matching.js";

// Package format v1 — based on Joakim Selemyr's web-mcp-hub (MIT), extended
// with minEngine (format evolution) and room for health/verification metadata.

/**
 * Capability floor, like an Android API level — an implementation-neutral
 * integer compared with plain `>=` against `ENGINE_VERSION` (see budgets.ts).
 * Not semver: the format has no patch releases, so semver's extra dimensions
 * are meaningless here. Lives on `package_versions` (see publishVersionSchema),
 * not package metadata, since engine requirements are a property of a
 * version's content — a user pinned to an older version must not be
 * told their engine is too old because of a newer version's requirements.
 */
export const engineLevelSchema = z.number().int().positive();

export const domainSchema = z
  .string()
  .min(1)
  .max(253)
  .transform((d) => d.toLowerCase().replace(/^www\./, ""))
  .refine(isRegistrableHostname, {
    message: "must be a concrete hostname beneath a registrable domain, not a public suffix",
  });

/** Chrome extension `@match`-style pattern, e.g. "*://*.wikipedia.org/wiki/*". */
export const urlPatternSchema = z
  .string()
  .min(1)
  .max(2048)
  .refine((v) => parseUrlPattern(v) !== null, {
    message: 'must be a match pattern like "*://*.example.com/*" (scheme://host/path)',
  });

const toolsArraySchema = z
  .array(toolDescriptorSchema)
  .min(1)
  .max(30)
  .superRefine((tools, ctx) => {
    const seen = new Set<string>();
    for (const [i, tool] of tools.entries()) {
      if (seen.has(tool.name)) {
        ctx.addIssue({
          code: "custom",
          message: `Duplicate tool name "${tool.name}"`,
          path: [i, "name"],
        });
      }
      seen.add(tool.name);
    }
  });

/**
 * Base object shape. Kept as a plain ZodObject (no refinement) so the derived
 * schemas below can still `.pick`/`.omit`/`.partial`/`.extend` it.
 * `createPackageSchema` wraps it with the api cross-validation.
 */
export const createPackageObjectSchema = z.strictObject({
  /**
   * Author-declared positive-integer version: `1` on create, exactly
   * `max(version)+1` on publish, equality-checked server-side (409 on
   * mismatch — docs/DECISIONS.md 2026-07-29). Not semver, same philosophy as
   * `minEngine`: the format has no patch releases, so semver's extra
   * dimensions are meaningless. Declared rather than server-assigned so a
   * publish based on a stale snapshot conflicts loudly instead of silently
   * superseding a version the author never saw.
   */
  version: z.number().int().min(1),
  domain: domainSchema,
  urlPatterns: z.array(urlPatternSchema).min(1).max(20),
  title: z.string().min(1).max(200),
  description: z.string().min(1).max(5000),
  tools: toolsArraySchema,
  /** Tier-1 API execution surface; tools bind to it via their `endpoint`. */
  api: apiBlockSchema,
  minEngine: engineLevelSchema,
  /** What changed in this version; shown to installed users deciding whether to update. */
  changelog: z.string().max(2000).optional(),
});

/**
 * Cross-field checks shared by every schema that carries a `domain` alongside
 * `urlPatterns`/`tools`/`api`: reference integrity within `api` (collectApiIssues),
 * urlPatterns scoped to the domain, and the domain reachable through those
 * patterns. `createPackageSchema` wires this in directly; the served-registry
 * envelope (`webMcpPackageSchema` in registry.ts) reuses it so a legacy row that
 * predates one of these checks fails closed instead of being served anyway.
 *
 * `domainIssuePath` lets a version-body schema (which has no `domain` field of
 * its own — the parent package supplies it) point the coverage issue at
 * `urlPatterns` instead of a field that doesn't exist in its input.
 */
export function applyDomainCrossValidation(
  pkg: ApiValidationTarget & { domain: string },
  ctx: z.RefinementCtx,
  domainIssuePath: (string | number)[] = ["domain"],
): void {
  for (const issue of collectApiIssues(pkg)) {
    ctx.addIssue({ code: "custom", message: issue.message, path: issue.path });
  }
  if (!urlPatternsWithinDomain(pkg.domain, pkg.urlPatterns)) {
    ctx.addIssue({
      code: "custom",
      message: `Every urlPatterns host must be "${pkg.domain}" or one of its subdomains; global and public-suffix wildcards are not allowed.`,
      path: ["urlPatterns"],
    });
  }
  // The lookup key `domain` must be reachable through the urlPatterns, or the
  // package publishes but no page can ever serve it (see domainCoveredByPatterns).
  if (!domainCoveredByPatterns(pkg.domain, pkg.urlPatterns)) {
    ctx.addIssue({
      code: "custom",
      message: `domain "${pkg.domain}" is not covered by any urlPatterns host, so it would be unreachable by lookup. Add a urlPattern whose host covers it (e.g. "*://${pkg.domain}/*").`,
      path: domainIssuePath,
    });
  }
}

/** DOM observations require the level-2 executor in every package envelope. */
export function applyDomEngineValidation(
  pkg: { tools: z.infer<typeof toolsArraySchema>; minEngine: number },
  ctx: z.RefinementCtx,
): void {
  if (pkg.tools.some((tool) => tool.execution.mode === "dom") && pkg.minEngine < 2) {
    ctx.addIssue({
      code: "custom",
      message: "DOM tools require minEngine 2 or newer",
      path: ["minEngine"],
    });
  }
}

/** What contributors submit (contributor identity comes from auth, not the body). */
export const createPackageSchema = createPackageObjectSchema.superRefine((pkg, ctx) => {
  applyDomainCrossValidation(pkg, ctx);
  applyDomEngineValidation(pkg, ctx);
});

/**
 * Metadata-only edits (packages row) — title and description. `domain` is the
 * package's immutable identity: it is set once at creation and never patched,
 * so a metadata edit can never move a package outside the content
 * (urlPatterns/api) its published versions already declared.
 */
export const updatePackageMetaSchema = createPackageObjectSchema
  .pick({ title: true, description: true })
  .partial();

/** A new version of an existing package (package_versions row) — append-only.
 * `api` travels with tools (it is execution data), so it is version-scoped too.
 * `minEngine` is also version-scoped: it describes what a specific version's
 * content requires, not the package as a whole. */
export const publishVersionSchema = createPackageObjectSchema
  .pick({
    version: true,
    urlPatterns: true,
    tools: true,
    api: true,
    changelog: true,
    minEngine: true,
  })
  .superRefine((pkg, ctx) => {
    for (const issue of collectApiIssues(pkg)) {
      ctx.addIssue({ code: "custom", message: issue.message, path: issue.path });
    }
    applyDomEngineValidation(pkg, ctx);
  });

/**
 * Version bodies do not carry a domain because it belongs to the parent
 * package. The publication route supplies the stored parent domain here, so
 * versioned URL patterns and API origins cannot escape it.
 */
export function publishVersionSchemaForDomain(domain: string) {
  return createPackageObjectSchema
    .pick({
      version: true,
      urlPatterns: true,
      tools: true,
      api: true,
      changelog: true,
      minEngine: true,
    })
    .superRefine((pkg, ctx) => {
      applyDomainCrossValidation({ ...pkg, domain }, ctx, ["urlPatterns"]);
      applyDomEngineValidation(pkg, ctx);
    });
}

export type CreatePackageInput = z.infer<typeof createPackageSchema>;
export type UpdatePackageMetaInput = z.infer<typeof updatePackageMetaSchema>;
export type PublishVersionInput = z.infer<typeof publishVersionSchema>;
