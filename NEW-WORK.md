# OpenAI WebMCP Challenge New Work

WebMCP Today existed before the challenge submission window. The annotated
`pre-webmcp-challenge` tag marks commit `60e3660`, the repository state before
the challenge-specific work below. Only commits after that tag are presented as
new work for judging.

## 2026-08-29

- Added four site-native, read-only WebMCP tools directly to `webmcp.today`:
  `search_packages`, `get_package`, `compare_packages`, and
  `verify_site_tools`.
- Registered the tools before React hydration from Next.js client
  instrumentation using the documented one-argument
  `document.modelContext.registerTool` call, with the legacy navigator location
  as a fallback. No browser extension is required for these four tools.
- Added bounded full-registry text search over servable package metadata and
  tool descriptors before pagination.
- Added focused tests for descriptors, API requests, result semantics, input and
  response validation, individual registration failures, unsupported browsers,
  and cleanup.
- Added judge testing instructions, tool inventory, sample prompts, and
  repository self-sufficiency notes to the README.

The challenge path uses only this repository's web app, public API, database,
schema package, and curated seed package. It has no runtime dependency on the
separate `webmcp-packages` repository.
