# @webmcp-today/schema

Zod schemas and TypeScript types for declarative [WebMCP Today](https://webmcp.today) package documents. Use it to validate package submissions, version bodies, registry responses, and the related API-backed tool format.

## Install

```bash
npm install @webmcp-today/schema
```

The package is ESM-only and includes its TypeScript declarations.

## Validate a package

`createPackageSchema` validates a complete package document. It checks package metadata, URL-pattern/domain scope, unique tool names, tool input schemas, and—when present—the API block's endpoint bindings and `{{parameter}}` references.

```ts
import { createPackageSchema } from "@webmcp-today/schema";

const result = createPackageSchema.safeParse({
  version: 1,
  domain: "github.com",
  urlPatterns: ["*://github.com/*"],
  title: "Example search tools",
  description: "Search tools for github.com.",
  api: {
    baseUrl: "https://github.com",
    endpoints: {
      search: {
        method: "GET",
        path: "/api/search",
        query: { q: "{{query}}" },
        returns: "results[].{title: title, url: url}",
      },
    },
  },
  tools: [
    {
      name: "search",
      description: "Search the site.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
        },
        required: ["query"],
      },
      annotations: { readOnlyHint: true },
      execution: { mode: "api", endpoint: "search" },
    },
  ],
});

if (!result.success) {
  console.error(result.error.issues);
} else {
  const pkg = result.data;
  // `domain` is normalized to lowercase, with a leading `www.` removed.
  console.log(pkg.domain);
}
```

`domain` must be a concrete, registrable hostname. Each `urlPatterns` entry uses a Chrome-extension-style match pattern and must stay within that domain. An API `baseUrl` must use HTTPS and be on the package domain or one of its subdomains. The only endpoint-level `baseUrl` exception is Hacker News's anonymous Firebase read API; it cannot use auth, and the executor omits cookies.

## API overview

All public values are exported from the package root.

- **Package schemas and types:** `createPackageSchema`, `createPackageObjectSchema`, `updatePackageMetaSchema`, `publishVersionSchema`, `publishVersionSchemaForDomain`, `CreatePackageInput`, `UpdatePackageMetaInput`, and `PublishVersionInput`.
- **Tool and input schemas:** `toolDescriptorSchema`, `inputSchemaSchema`, `executionDescriptorSchema`, `apiExecutionSchema`, `domExecutionSchema`, and their inferred types. DOM tools declare 1–16 exact semantic role/name observations and return only presence or allowed boolean states. They require an empty input schema, read-only and untrusted-content hints, and `minEngine: 2`.
- **API format:** `apiBlockSchema`, `apiEndpointSchema`, `apiAuthSourceSchema`, `apiGraphqlSchema`, `collectApiIssues`, and the `ApiBlock`/`ApiEndpoint` types. Endpoints can declare a method, path, query, one request-body form (`body`, `form`, or `graphql`), optional JMESPath `returns`, error locators, and named auth sources.
- **Registry and bridge wire schemas:** `webMcpPackageSchema`, response schemas such as `packageLookupResponseSchema`, `bridgeRequestSchema`, and local-bridge request/response schemas.
- **Utilities and constants:** URL-pattern parsing/matching helpers including `matchUrlPattern` and `rankPackagesByUrl`; `unknownPlaceholders`; `canonicalizeApiBlock` and `apiContentHash`; and limits such as `TOOL_NAME_MAX`, `TOOL_DESCRIPTION_MAX`, and `ENGINE_VERSION`.

The `api` block remains required. A DOM-only package currently carries an inert same-site block with `endpoints: {}`; API tools still require their referenced endpoint. Publishing this public format change requires a schema minor release followed by an engine minor release; publish the schema first so the engine can depend on it.

For exact field constraints and all exports, see the [source](https://github.com/robertn702/webmcp-today/tree/main/packages/schema/src) and the [API-backed package-format documentation](https://github.com/robertn702/webmcp-today/blob/main/docs/api-execution-model.md).

## License

[MIT](./LICENSE)
