// Publish-time metadata character budgets from Chrome's WebMCP guidance
// (https://developer.chrome.com/docs/ai/webmcp). These caps are enforced.
// There is no tool-output cap: the 1.5K TOOL_OUTPUT_MAX was removed for v1
// (model-dependent — Chrome's 1.5K is guidance, not enforcement). Revisit when
// we design output-budget customization — see docs/DECISIONS.md 2026-07-24.

export const TOOL_NAME_MAX = 30;
export const TOOL_DESCRIPTION_MAX = 500;
export const PARAM_DESCRIPTION_MAX = 150;

/** Current package format engine version — a capability level compared with
 *  plain `>=` against a version's `minEngine` (docs/DECISIONS.md 2026-07-24).
 *
 *  Level 2 adds read-only DOM observations. The extension refuses packages whose
 *  minEngine exceeds its supported level. */
export const ENGINE_VERSION = 2;
