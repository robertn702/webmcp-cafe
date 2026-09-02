import {
  toolDescriptorSchema,
  validateToolInput,
  type DomObservation,
  type ToolDescriptor,
} from "@webmcp-today/schema";
import { mcpResult } from "./mcp-result.js";
import type { McpResult } from "./result.js";

const MAX_ELEMENTS = 10_000;
const MAX_CANDIDATES = 2_000;
const MAX_NAME_WORK = 4_000;
const MAX_INDEX_WORK = 10_000;
const MAX_NAME_NODES = 256;
const MAX_NAME_BYTES = 512;
const MAX_ID_BYTES = 512;
const MAX_OUTPUT_BYTES = 4096;
const PRUNED_TAGS = new Set([
  "SELECT",
  "OPTION",
  "IFRAME",
  "OBJECT",
  "EMBED",
  "SCRIPT",
  "STYLE",
  "TEMPLATE",
  "NOSCRIPT",
]);
const TEXT_EXCLUDED_TAGS = new Set(["INPUT", "TEXTAREA", ...PRUNED_TAGS]);

export type DomToolDescriptor = ToolDescriptor;

export interface DomExecutionContext {
  document: Document;
  registrationUrl: string;
  signal: AbortSignal;
}

type DomOutput = Record<string, { matched: false } | { matched: true; value?: boolean }>;
type IdEntry = { element: Element; eligible: boolean };
type IdIndex = Map<string, IdEntry | null>;

interface NameBudget {
  work: number;
}

function utf8LengthAtMost(value: string, limit: number): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else bytes += 3;
    if (bytes > limit) return limit + 1;
  }
  return bytes;
}

function normalizeText(value: string): string {
  return value.normalize("NFC").replace(/\s+/gu, " ").trim();
}

function boundedNameString(value: string, budget: NameBudget): string {
  addNameWork(budget);
  if (value.length > MAX_NAME_BYTES || utf8LengthAtMost(value, MAX_NAME_BYTES) > MAX_NAME_BYTES) {
    throw new Error("DOM name-byte limit");
  }
  return normalizeText(value);
}

function isPrunedSelf(element: Element): boolean {
  if (PRUNED_TAGS.has(element.tagName)) return true;
  if (element.hasAttribute("hidden") || element.hasAttribute("inert")) return true;
  if (element.getAttribute("contenteditable") !== null) return true;
  if (element.getAttribute("aria-hidden")?.trim().toLowerCase() === "true") return true;
  if (element.tagName !== "INPUT") return false;
  const type = element.getAttribute("type")?.trim().toLowerCase() ?? "text";
  return ["button", "submit", "reset", "image", "password", "hidden"].includes(type);
}

function addNameWork(budget: NameBudget): void {
  budget.work += 1;
  if (budget.work > MAX_NAME_WORK) throw new Error("DOM name-work limit");
}

/** Text-only, light-DOM extraction. It never reads a container's textContent. */
function safeText(element: Element, eligible: Map<Element, boolean>, budget: NameBudget): string {
  if (eligible.get(element) !== true || TEXT_EXCLUDED_TAGS.has(element.tagName)) return "";
  let nodes = 0;
  let bytes = 0;
  let text = "";
  let node: Node | null = element.firstChild;

  while (node !== null) {
    nodes += 1;
    addNameWork(budget);
    if (nodes > MAX_NAME_NODES) throw new Error("DOM name-node limit");
    if (node.nodeType === 3) {
      const value = node.nodeValue ?? "";
      if (value.length > MAX_NAME_BYTES) throw new Error("DOM name-byte limit");
      bytes += utf8LengthAtMost(value, MAX_NAME_BYTES - bytes);
      if (bytes > MAX_NAME_BYTES) throw new Error("DOM name-byte limit");
      text += value;
    }

    const child =
      node instanceof Element &&
      eligible.get(node) === true &&
      !TEXT_EXCLUDED_TAGS.has(node.tagName)
        ? node.firstChild
        : null;
    if (child !== null) {
      node = child;
      continue;
    }
    while (node !== null && node !== element && node.nextSibling === null) node = node.parentNode;
    if (node === null || node === element) break;
    node = node.nextSibling;
  }
  return normalizeText(text);
}

function isNameSourceEligible(element: Element, eligible: Map<Element, boolean>): boolean {
  return eligible.get(element) === true && !TEXT_EXCLUDED_TAGS.has(element.tagName);
}

function ariaName(
  element: Element,
  idIndex: IdIndex,
  eligible: Map<Element, boolean>,
  budget: NameBudget,
): string | null {
  const labelledBy = element.getAttribute("aria-labelledby");
  if (labelledBy !== null) {
    const normalizedReferences = boundedNameString(labelledBy, budget);
    const references = normalizedReferences.split(/\s+/u).filter(Boolean);
    if (references.length === 0 || new Set(references).size !== references.length) {
      throw new Error("invalid aria-labelledby");
    }
    let name = "";
    for (const reference of references) {
      const entry = idIndex.get(reference);
      if (
        entry === undefined ||
        entry === null ||
        !entry.eligible ||
        !isNameSourceEligible(entry.element, eligible)
      ) {
        throw new Error("invalid aria-labelledby");
      }
      const part = safeText(entry.element, eligible, budget);
      if (name.length + part.length > MAX_NAME_BYTES) throw new Error("DOM name-byte limit");
      name += name === "" ? part : ` ${part}`;
    }
    return boundedNameString(name, budget);
  }
  const label = element.getAttribute("aria-label");
  return label === null ? null : boundedNameString(label, budget);
}

function labelName(
  element: Element,
  idIndex: IdIndex,
  eligible: Map<Element, boolean>,
  budget: NameBudget,
): string | null {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    const id = element.getAttribute("id");
    if (id !== null && id !== "") {
      const entry = idIndex.get(id);
      if (entry === null || entry?.element !== element) throw new Error("ambiguous label target");
    }
    const labels = element.labels;
    if (labels !== null && labels !== undefined) {
      if (labels.length > 1) throw new Error("ambiguous control labels");
      if (labels.length === 0) return null;
      addNameWork(budget);
      const label = labels.item(0);
      if (label !== null && eligible.get(label) === true) return safeText(label, eligible, budget);
      return null;
    }
  }
  let parent = element.parentElement;
  while (parent !== null) {
    addNameWork(budget);
    if (parent.tagName === "LABEL") {
      return eligible.get(parent) === true ? safeText(parent, eligible, budget) : null;
    }
    parent = parent.parentElement;
  }
  return null;
}

function fieldsetName(
  element: Element,
  eligible: Map<Element, boolean>,
  budget: NameBudget,
): string | null {
  let child = element.firstElementChild;
  while (child !== null) {
    addNameWork(budget);
    if (child.tagName === "LEGEND") return safeText(child, eligible, budget);
    child = child.nextElementSibling;
  }
  return null;
}

function nativeInputRole(element: Element): DomObservation["role"] | null {
  const type = element.getAttribute("type")?.toLowerCase() ?? "text";
  if (type === "checkbox") return "checkbox";
  if (element.hasAttribute("list")) return null;
  return ["text", "email", "tel", "url"].includes(type) ? "textbox" : null;
}

function roleFor(element: Element): DomObservation["role"] | null {
  const explicitRole = element.getAttribute("role");
  if (element.tagName === "INPUT") {
    const nativeRole = nativeInputRole(element);
    if (nativeRole === null) return null;
    return explicitRole === null || explicitRole === nativeRole ? nativeRole : null;
  }
  if (element.tagName === "TEXTAREA")
    return explicitRole === null || explicitRole === "textbox" ? "textbox" : null;
  if (explicitRole !== null) {
    if (explicitRole === "button") return "button";
    if (explicitRole === "checkbox") return "checkbox";
    if (explicitRole === "group") return "group";
    if (explicitRole === "heading") return "heading";
    if (explicitRole === "link") return "link";
    if (explicitRole === "textbox") return "textbox";
    return null;
  }
  if (element.tagName === "BUTTON") return "button";
  if (element.tagName === "A" && element.hasAttribute("href")) return "link";
  if (/^H[1-6]$/u.test(element.tagName)) return "heading";
  return element.tagName === "FIELDSET" ? "group" : null;
}

function accessibleName(
  element: Element,
  role: DomObservation["role"],
  idIndex: IdIndex,
  eligible: Map<Element, boolean>,
  budget: NameBudget,
): string | null {
  const aria = ariaName(element, idIndex, eligible, budget);
  if (aria !== null) return aria;
  if (role === "checkbox" || role === "textbox")
    return labelName(element, idIndex, eligible, budget);
  if (role === "group" && element.tagName === "FIELDSET")
    return fieldsetName(element, eligible, budget);
  return role === "button" || role === "link" || role === "heading"
    ? safeText(element, eligible, budget)
    : null;
}

function ariaBoolean(element: Element, attribute: string): boolean | undefined {
  const value = element.getAttribute(attribute);
  if (value === null) return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error("invalid ARIA boolean state");
}

function isFirstLegendDescendant(element: Element, fieldset: Element, budget: NameBudget): boolean {
  let child = fieldset.firstElementChild;
  while (child !== null) {
    addNameWork(budget);
    if (child.tagName === "LEGEND") {
      let parent: Element | null = element;
      while (parent !== null && parent !== fieldset) {
        addNameWork(budget);
        if (parent === child) return true;
        parent = parent.parentElement;
      }
      return false;
    }
    child = child.nextElementSibling;
  }
  return false;
}

function nativeDisabled(element: Element, budget: NameBudget): boolean | undefined {
  if (!["BUTTON", "INPUT", "TEXTAREA"].includes(element.tagName)) return undefined;
  const direct = Reflect.get(element, "disabled");
  if (typeof direct !== "boolean") throw new Error("undetermined native disabled state");
  if (direct) return true;
  let parent = element.parentElement;
  while (parent !== null) {
    addNameWork(budget);
    if (parent.tagName === "FIELDSET") {
      const disabled = Reflect.get(parent, "disabled");
      if (typeof disabled !== "boolean") throw new Error("undetermined inherited disabled state");
      if (disabled && !isFirstLegendDescendant(element, parent, budget)) return true;
    }
    parent = parent.parentElement;
  }
  return false;
}

function nativeBoolean(
  element: Element,
  read: DomObservation["read"],
  budget: NameBudget,
): boolean | undefined {
  if (
    read === "checked" &&
    element.tagName === "INPUT" &&
    nativeInputRole(element) === "checkbox"
  ) {
    if (Reflect.get(element, "indeterminate") === true) throw new Error("indeterminate checkbox");
    const checked = Reflect.get(element, "checked");
    if (typeof checked !== "boolean") throw new Error("undetermined native checked state");
    return checked;
  }
  if (read === "required" && (element.tagName === "INPUT" || element.tagName === "TEXTAREA")) {
    const required = Reflect.get(element, "required");
    if (typeof required !== "boolean") throw new Error("undetermined native required state");
    return required;
  }
  return read === "disabled" ? nativeDisabled(element, budget) : undefined;
}

function readState(element: Element, read: DomObservation["read"], budget: NameBudget): boolean {
  const attribute = read === "checked" ? "aria-checked" : `aria-${read}`;
  const aria = ariaBoolean(element, attribute);
  const native = nativeBoolean(element, read, budget);
  if (aria !== undefined && native !== undefined) throw new Error("mixed native and ARIA state");
  if (aria !== undefined) return aria;
  if (native !== undefined) return native;
  throw new Error("unsupported DOM state");
}

function assertLiveTopLevelDocument(context: DomExecutionContext): void {
  if (context.signal.aborted) throw new Error("aborted");
  const registration = new URL(context.registrationUrl);
  if (registration.protocol !== "http:" && registration.protocol !== "https:") {
    throw new Error("registration URL is not http(s)");
  }
  const view = context.document.defaultView;
  if (view === null) throw new Error("missing browsing context");
  if (view.top !== view || view.parent !== view) throw new Error("frame context");
  const current = new URL(view.location.href);
  if (current.href !== registration.href || current.origin !== registration.origin) {
    throw new Error("stale registration");
  }
}

function collectLightDom(document: Document): {
  elements: Element[];
  eligible: Map<Element, boolean>;
  idIndex: IdIndex;
} {
  const root = document.documentElement;
  if (root === null) throw new Error("missing document root");
  const elements: Element[] = [];
  const eligible = new Map<Element, boolean>();
  const idIndex: IdIndex = new Map();
  let current: Element | null = root;
  let visited = 0;
  let indexWork = 0;

  while (current !== null) {
    visited += 1;
    indexWork += 1;
    if (visited > MAX_ELEMENTS || indexWork > MAX_INDEX_WORK)
      throw new Error("DOM traversal limit");
    const parent = current.parentElement;
    const parentEligible = parent === null || eligible.get(parent) === true;
    const currentEligible = parentEligible && !isPrunedSelf(current);
    eligible.set(current, currentEligible);
    elements.push(current);
    const id = current.getAttribute("id");
    if (id !== null && id !== "") {
      if (id.length > MAX_ID_BYTES || utf8LengthAtMost(id, MAX_ID_BYTES) > MAX_ID_BYTES) {
        throw new Error("DOM id-byte limit");
      }
      idIndex.set(id, idIndex.has(id) ? null : { element: current, eligible: currentEligible });
    }

    if (current.firstElementChild !== null) {
      current = current.firstElementChild;
      continue;
    }
    while (current !== null && current !== root && current.nextElementSibling === null)
      current = current.parentElement;
    if (current === null || current === root) break;
    current = current.nextElementSibling;
  }
  return { elements, eligible, idIndex };
}

/** Executes one declarative DOM tool against only the live top-level light DOM. */
export async function executeDomTool(
  tool: DomToolDescriptor,
  input: unknown,
  context: DomExecutionContext,
): Promise<McpResult> {
  try {
    const parsedTool = toolDescriptorSchema.safeParse(tool);
    if (!parsedTool.success || parsedTool.data.execution.mode !== "dom")
      throw new Error("invalid DOM descriptor");
    if (!validateToolInput(parsedTool.data.inputSchema, input).success)
      throw new Error("invalid DOM input");
    assertLiveTopLevelDocument(context);

    const { elements, eligible, idIndex } = collectLightDom(context.document);
    const observationsByRole = new Map<DomObservation["role"], Array<[string, DomObservation]>>();
    const matches = new Map<string, Element>();
    for (const [key, observation] of Object.entries(parsedTool.data.execution.observations)) {
      const roleObservations = observationsByRole.get(observation.role) ?? [];
      roleObservations.push([key, observation]);
      observationsByRole.set(observation.role, roleObservations);
    }

    let candidates = 0;
    const nameBudget: NameBudget = { work: 0 };
    for (const element of elements) {
      if (eligible.get(element) !== true) continue;
      const role = roleFor(element);
      if (role === null) continue;
      const observations = observationsByRole.get(role);
      if (observations === undefined) continue;
      candidates += 1;
      if (candidates > MAX_CANDIDATES) throw new Error("DOM candidate limit");
      const name = accessibleName(element, role, idIndex, eligible, nameBudget);
      for (const [key, observation] of observations) {
        if (name !== observation.name) continue;
        if (matches.has(key)) throw new Error("ambiguous DOM match");
        matches.set(key, element);
      }
    }

    const output: DomOutput = {};
    for (const [key, observation] of Object.entries(parsedTool.data.execution.observations)) {
      const element = matches.get(key);
      if (element === undefined) output[key] = { matched: false };
      else if (observation.read === "exists") output[key] = { matched: true };
      else output[key] = { matched: true, value: readState(element, observation.read, nameBudget) };
    }

    const text = JSON.stringify(output);
    if (utf8LengthAtMost(text, MAX_OUTPUT_BYTES) > MAX_OUTPUT_BYTES)
      throw new Error("DOM output limit");
    return mcpResult(text);
  } catch {
    return mcpResult("DOM tool execution failed.");
  }
}
