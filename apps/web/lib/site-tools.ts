import {
  packageListResponseSchema,
  packageLookupResponseSchema,
  webMcpPackageSchema,
  type WebMcpPackage,
} from "@webmcp-today/schema";
import { z } from "zod";

export type SiteTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint: true; untrustedContentHint: true };
  execute: (input: Record<string, unknown>) => Promise<unknown>;
};

export type ModelContextLike = {
  registerTool(tool: SiteTool): Promise<unknown>;
};

const searchInputSchema = z
  .object({
    query: z.string().trim().min(1).max(200),
    domain: z.string().trim().min(1).max(253).optional(),
    limit: z.number().int().min(1).max(20).optional(),
  })
  .strict();

const getInputSchema = z.object({ id: z.string().trim().min(1).max(200) }).strict();
const compareInputSchema = z
  .object({ ids: z.array(z.string().trim().min(1).max(200)).min(2).max(4) })
  .strict();

function parseUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

const verifyInputSchema = z
  .object({
    url: z
      .string()
      .url()
      .refine((value) => {
        const protocol = parseUrl(value)?.protocol;
        return protocol === "http:" || protocol === "https:";
      }, "Must be an absolute http or https URL")
      .refine((value) => {
        const url = parseUrl(value);
        return url !== undefined && url.username === "" && url.password === "";
      }, "URL credentials are not allowed"),
  })
  .strict();

function errorResult(error: unknown): { error: string } {
  const message = error instanceof Error ? error.message : "Unexpected registry error";
  return { error: message };
}

async function fetchJson(path: string): Promise<unknown> {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`Registry request failed (${response.status})`);
  return response.json();
}

function packageSummary(pkg: WebMcpPackage) {
  return {
    id: pkg.id,
    title: pkg.title,
    description: pkg.description,
    domain: pkg.domain,
    contributor: pkg.contributor,
    toolNames: pkg.tools.map((tool) => tool.name),
  };
}

function normalizePageUrl(value: string): string {
  const url = parseUrl(value);
  if (!url) throw new Error("Invalid URL");
  url.search = "";
  url.hash = "";
  return url.href;
}

function execute<Input>(
  schema: z.ZodType<Input>,
  callback: (input: Input) => Promise<unknown>,
): (input: Record<string, unknown>) => Promise<unknown> {
  return async (input) => {
    const parsed = schema.safeParse(input);
    if (!parsed.success) return errorResult(parsed.error);
    try {
      return await callback(parsed.data);
    } catch (error) {
      return errorResult(error);
    }
  };
}

// Package metadata is contributor-controlled, so keep Chrome's explicit
// untrusted-content signal in addition to the read-only side-effect hint.
const readOnlyAnnotations = { readOnlyHint: true, untrustedContentHint: true } as const;

export function createSiteTools(): SiteTool[] {
  return [
    {
      name: "search_packages",
      description:
        "Search the WebMCP Today registry for servable packages by text and optional domain.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["query"],
        properties: {
          query: { type: "string", minLength: 1, maxLength: 200, description: "Text to search." },
          domain: { type: "string", maxLength: 253, description: "Optional package domain." },
          limit: { type: "integer", minimum: 1, maximum: 20, description: "Maximum results." },
        },
      },
      annotations: readOnlyAnnotations,
      execute: execute(searchInputSchema, async ({ query, domain, limit = 10 }) => {
        const params = new URLSearchParams({ q: query, page: "1", pageSize: String(limit) });
        if (domain) params.set("domain", domain);
        const parsed = packageListResponseSchema.safeParse(
          await fetchJson(`/api/packages?${params}`),
        );
        if (!parsed.success) return errorResult(parsed.error);
        return {
          total: parsed.data.total,
          packages: parsed.data.packages.map(packageSummary),
        };
      }),
    },
    {
      name: "get_package",
      description: "Get the latest served version of a WebMCP Today package by ID.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["id"],
        properties: {
          id: { type: "string", minLength: 1, maxLength: 200, description: "Package ID." },
        },
      },
      annotations: readOnlyAnnotations,
      execute: execute(getInputSchema, async ({ id }) => {
        const parsed = webMcpPackageSchema.safeParse(
          await fetchJson(`/api/packages/${encodeURIComponent(id)}`),
        );
        if (!parsed.success) return errorResult(parsed.error);
        return parsed.data;
      }),
    },
    {
      name: "compare_packages",
      description: "Compare two to four WebMCP Today packages by their registered tool names.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["ids"],
        properties: {
          ids: {
            type: "array",
            minItems: 2,
            maxItems: 4,
            items: { type: "string", minLength: 1, maxLength: 200 },
            description: "Two to four package IDs.",
          },
        },
      },
      annotations: readOnlyAnnotations,
      execute: execute(compareInputSchema, async ({ ids }) => {
        const packages = await Promise.all(
          ids.map(async (id) => {
            const parsed = webMcpPackageSchema.safeParse(
              await fetchJson(`/api/packages/${encodeURIComponent(id)}`),
            );
            if (!parsed.success) throw new Error("Registry returned an invalid package");
            return parsed.data;
          }),
        );
        const toolSets = packages.map((pkg) => new Set(pkg.tools.map((tool) => tool.name)));
        const firstTools = toolSets[0] ?? new Set<string>();
        const commonToolNames = [...firstTools].filter((name) =>
          toolSets.every((tools) => tools.has(name)),
        );
        return {
          packages: packages.map(packageSummary),
          commonToolNames,
          uniqueToolNames: packages.map((pkg, index) => ({
            id: pkg.id,
            toolNames: pkg.tools
              .map((tool) => tool.name)
              .filter((name) =>
                toolSets.every((tools, otherIndex) => otherIndex === index || !tools.has(name)),
              ),
          })),
        };
      }),
    },
    {
      name: "verify_site_tools",
      description:
        "Find registry packages matching an absolute site URL and their registered tool descriptors.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["url"],
        properties: {
          url: { type: "string", format: "uri", description: "Absolute http or https URL." },
        },
      },
      annotations: readOnlyAnnotations,
      execute: execute(verifyInputSchema, async ({ url }) => {
        const normalizedUrl = normalizePageUrl(url);
        const params = new URLSearchParams({ url: normalizedUrl });
        const parsed = packageLookupResponseSchema.safeParse(
          await fetchJson(`/api/packages/lookup?${params}`),
        );
        if (!parsed.success) return errorResult(parsed.error);
        return {
          url: normalizedUrl,
          packages: parsed.data.packages.map((pkg) => ({
            ...packageSummary(pkg),
            tools: pkg.tools,
          })),
        };
      }),
    },
  ];
}

function isModelContext(value: unknown): value is ModelContextLike {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "registerTool") === "function"
  );
}

export function getSiteModelContext(): ModelContextLike | undefined {
  if (typeof document !== "undefined") {
    const documentContext = Reflect.get(document, "modelContext");
    if (isModelContext(documentContext)) return documentContext;
  }
  if (typeof navigator !== "undefined") {
    const navigatorContext = Reflect.get(navigator, "modelContext");
    if (isModelContext(navigatorContext)) return navigatorContext;
  }
  return undefined;
}

export function registerSiteTools(modelContext = getSiteModelContext()): {
  ready: Promise<void>;
} {
  if (!modelContext) return { ready: Promise.resolve() };
  const ready = Promise.all(
    createSiteTools().map(async (tool) => {
      try {
        await modelContext.registerTool(tool);
      } catch (error) {
        // A duplicate or unsupported individual tool must not block the rest.
        console.warn(`[webmcp-today] Failed to register site tool "${tool.name}":`, error);
      }
    }),
  ).then(() => undefined);
  return { ready };
}
