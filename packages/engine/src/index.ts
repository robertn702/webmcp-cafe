// The engine's public surface, named explicitly rather than `export *`: this is
// a published package, so anything re-exported here is API we owe compatibility
// on. buildRequest and handleResponse are the supported lower-level request and
// response helpers. The rest of api-executor.ts stays internal.

export { buildRequest, executeApiTool, handleResponse } from "./api-executor.js";
export type { ApiToolDescriptor, DerivedRequest, FetchOutcome } from "./api-executor.js";
export { requiredEngineLevel, supportsPackageEngine } from "./engine-gate.js";
export type { McpResult, McpTextContent } from "./result.js";
