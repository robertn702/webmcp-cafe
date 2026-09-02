import { afterEach, describe, expect, it, vi } from "vitest";
import { parseHTML } from "linkedom";
import { toolDescriptorSchema } from "@webmcp-today/schema";
import { executeDomTool, type DomToolDescriptor } from "../src/dom-executor.js";

const URL = "https://example.com/checkout";

function tool(observations: Record<string, unknown>): DomToolDescriptor {
  const parsed = toolDescriptorSchema.parse({
    name: "checkout_status",
    description: "Read checkout status.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    execution: { mode: "dom", observations },
  });
  if (parsed.execution.mode !== "dom") throw new Error("expected DOM tool descriptor");
  return { ...parsed, execution: parsed.execution };
}

function page(html: string, url = URL) {
  const { document, window } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
  Object.defineProperty(window, "location", { configurable: true, value: { href: url } });
  Object.defineProperty(window, "top", { configurable: true, value: window });
  Object.defineProperty(window, "parent", { configurable: true, value: window });
  for (const input of Array.from(document.querySelectorAll("input[checked]"))) {
    Reflect.set(input, "checked", true);
  }
  for (const input of Array.from(document.querySelectorAll("input[required]"))) {
    Reflect.set(input, "required", true);
  }
  for (const input of Array.from(document.querySelectorAll("input"))) {
    Reflect.set(input, "indeterminate", false);
  }
  for (const button of Array.from(document.querySelectorAll("button[disabled]"))) {
    Reflect.set(button, "disabled", true);
  }
  for (const fieldset of Array.from(document.querySelectorAll("fieldset[disabled]"))) {
    Reflect.set(fieldset, "disabled", true);
  }
  vi.stubGlobal("Element", window.Element);
  vi.stubGlobal("HTMLInputElement", window.HTMLInputElement);
  vi.stubGlobal("HTMLTextAreaElement", window.HTMLTextAreaElement);
  vi.stubGlobal("HTMLButtonElement", window.HTMLButtonElement);
  vi.stubGlobal("HTMLFieldSetElement", window.HTMLFieldSetElement);
  return { document, window };
}

async function execute(
  html: string,
  observations: Record<string, unknown>,
  options?: { url?: string; signal?: AbortSignal },
) {
  const { document } = page(html, options?.url ?? URL);
  return executeDomTool(
    tool(observations),
    {},
    {
      document,
      registrationUrl: URL,
      signal: options?.signal ?? new AbortController().signal,
    },
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("executeDomTool", () => {
  it("returns only allowed boolean states for semantic controls", async () => {
    const result = await execute(
      `<button aria-label="Pay now" disabled>ignored</button>
       <label><input type="checkbox" checked required> Accept terms</label>
       <fieldset><legend>Delivery</legend></fieldset>`,
      {
        pay: { role: "button", name: "Pay now", read: "disabled" },
        terms: { role: "checkbox", name: "Accept terms", read: "checked" },
        terms_required: { role: "checkbox", name: "Accept terms", read: "required" },
        delivery: { role: "group", name: "Delivery", read: "exists" },
      },
    );
    expect(result.content[0]?.text).toBe(
      '{"pay":{"matched":true,"value":true},"terms":{"matched":true,"value":true},"terms_required":{"matched":true,"value":true},"delivery":{"matched":true}}',
    );
  });

  it("returns matched false for zero matches and fails closed for ambiguous matches", async () => {
    const absent = await execute("<main></main>", {
      help: { role: "link", name: "Help", read: "exists" },
    });
    expect(absent.content[0]?.text).toBe('{"help":{"matched":false}}');

    const ambiguous = await execute("<button>Continue</button><button>Continue</button>", {
      continue: { role: "button", name: "Continue", read: "exists" },
    });
    expect(ambiguous.content[0]?.text).toBe("DOM tool execution failed.");
  });

  it("rejects stale URLs, frames, and aborted calls", async () => {
    const stale = await execute(
      "<button>Continue</button>",
      {
        continue: { role: "button", name: "Continue", read: "exists" },
      },
      { url: "https://example.com/other" },
    );
    expect(stale.content[0]?.text).toBe("DOM tool execution failed.");

    const frame = page("<button>Continue</button>");
    Object.defineProperty(frame.window, "top", { configurable: true, value: {} });
    const framed = await executeDomTool(
      tool({ continue: { role: "button", name: "Continue", read: "exists" } }),
      {},
      {
        document: frame.document,
        registrationUrl: URL,
        signal: new AbortController().signal,
      },
    );
    expect(framed.content[0]?.text).toBe("DOM tool execution failed.");

    const controller = new AbortController();
    controller.abort();
    const aborted = await execute(
      "<button>Continue</button>",
      {
        continue: { role: "button", name: "Continue", read: "exists" },
      },
      { signal: controller.signal },
    );
    expect(aborted.content[0]?.text).toBe("DOM tool execution failed.");
  });

  it("never derives names from sensitive fields or ignored frame/shadow content", async () => {
    const { document } = page(
      '<input type="password" aria-label="Account password"><input type="hidden" aria-label="Hidden"><input type="button" value="Pay now"><input type="text" value="Sensitive value"><iframe><div role="button">Pay now</div></iframe><div id="host"></div>',
    );
    const host = document.getElementById("host");
    if (host === null) throw new Error("fixture missing host");
    host.attachShadow({ mode: "open" }).innerHTML = '<div role="button">Pay now</div>';
    const result = await executeDomTool(
      tool({
        pay: { role: "button", name: "Pay now", read: "exists" },
        sensitive: { role: "textbox", name: "Sensitive value", read: "exists" },
      }),
      {},
      { document, registrationUrl: URL, signal: new AbortController().signal },
    );
    expect(result.content[0]?.text).toBe('{"pay":{"matched":false},"sensitive":{"matched":false}}');
  });

  it("prunes forbidden subtrees before explicit-role candidate matching", async () => {
    const result = await execute(
      `<input type="password" role="checkbox" aria-label="Private" aria-checked="true">
       <input type="hidden" role="textbox" aria-label="Private">
       <div hidden role="button">Hidden button</div>
       <div inert role="button">Inert button</div>
       <div aria-hidden="true" role="button">ARIA hidden button</div>
       <div contenteditable="true" role="button">Editable button</div>
       <script><div role="button">Script button</div></script>`,
      {
        password: { role: "checkbox", name: "Private", read: "checked" },
        hidden: { role: "textbox", name: "Private", read: "exists" },
        hidden_button: { role: "button", name: "Hidden button", read: "exists" },
        inert_button: { role: "button", name: "Inert button", read: "exists" },
        aria_hidden: { role: "button", name: "ARIA hidden button", read: "exists" },
        editable: { role: "button", name: "Editable button", read: "exists" },
      },
    );
    expect(result.content[0]?.text).toBe(
      '{"password":{"matched":false},"hidden":{"matched":false},"hidden_button":{"matched":false},"inert_button":{"matched":false},"aria_hidden":{"matched":false},"editable":{"matched":false}}',
    );
  });

  it("keeps value-bearing hosts in their narrow native role set and rejects unsafe name sources", async () => {
    const textareaRole = await execute(
      '<textarea role="button" aria-label="Pay">secret</textarea>',
      {
        pay: { role: "button", name: "Pay", read: "exists" },
      },
    );
    expect(textareaRole.content[0]?.text).toBe('{"pay":{"matched":false}}');

    const textareaLabel = await execute(
      '<textarea id="copy">secret</textarea><button aria-labelledby="copy"></button>',
      {
        pay: { role: "button", name: "Pay", read: "exists" },
      },
    );
    expect(textareaLabel.content[0]?.text).toBe("DOM tool execution failed.");

    const hiddenLabel = await execute(
      '<label hidden><input type="checkbox"> Accept terms</label><input type="checkbox">',
      { terms: { role: "checkbox", name: "Accept terms", read: "exists" } },
    );
    expect(hiddenLabel.content[0]?.text).toBe('{"terms":{"matched":false}}');

    const inertLabel = await execute(
      '<label inert><input type="checkbox"> Accept terms</label><input type="checkbox">',
      { terms: { role: "checkbox", name: "Accept terms", read: "exists" } },
    );
    expect(inertLabel.content[0]?.text).toBe('{"terms":{"matched":false}}');

    const combobox = await execute('<input type="text" list="suggestions" aria-label="Search">', {
      search: { role: "textbox", name: "Search", read: "exists" },
    });
    expect(combobox.content[0]?.text).toBe('{"search":{"matched":false}}');
  });

  it("fails closed for multiple native labels and duplicate label targets", async () => {
    const multiple = page(
      '<label id="first">Primary</label><label id="second">Secondary</label><input id="email" type="text">',
    );
    const input = multiple.document.getElementById("email");
    const first = multiple.document.getElementById("first");
    const second = multiple.document.getElementById("second");
    if (input === null || first === null || second === null)
      throw new Error("fixture missing label");
    Object.defineProperty(input, "labels", {
      configurable: true,
      value: {
        length: 2,
        item(index: number) {
          if (index === 0) return first;
          return index === 1 ? second : null;
        },
      },
    });
    const multipleResult = await executeDomTool(
      tool({ email: { role: "textbox", name: "Primary", read: "exists" } }),
      {},
      {
        document: multiple.document,
        registrationUrl: URL,
        signal: new AbortController().signal,
      },
    );
    expect(multipleResult.content[0]?.text).toBe("DOM tool execution failed.");

    const duplicateTarget = await execute(
      '<label for="email">Email</label><input id="email" type="text"><input id="email" type="text">',
      { email: { role: "textbox", name: "Email", read: "exists" } },
    );
    expect(duplicateTarget.content[0]?.text).toBe("DOM tool execution failed.");
  });

  it("uses the narrow native/ARIA boolean state matrix", async () => {
    const result = await execute(
      `<div role="checkbox" aria-label="Terms" aria-checked="true"></div>
       <div role="button" aria-label="Pay" aria-disabled="false"></div>
       <div role="textbox" aria-label="Email" aria-required="true"></div>`,
      {
        terms: { role: "checkbox", name: "Terms", read: "checked" },
        pay: { role: "button", name: "Pay", read: "disabled" },
        email: { role: "textbox", name: "Email", read: "required" },
      },
    );
    expect(result.content[0]?.text).toBe(
      '{"terms":{"matched":true,"value":true},"pay":{"matched":true,"value":false},"email":{"matched":true,"value":true}}',
    );

    const invalid = await execute(
      '<div role="checkbox" aria-label="Terms" aria-checked="mixed"></div>',
      {
        terms: { role: "checkbox", name: "Terms", read: "checked" },
      },
    );
    expect(invalid.content[0]?.text).toBe("DOM tool execution failed.");

    const mixed = await execute('<input type="checkbox" aria-label="Terms" aria-checked="true">', {
      terms: { role: "checkbox", name: "Terms", read: "checked" },
    });
    expect(mixed.content[0]?.text).toBe("DOM tool execution failed.");

    const indeterminate = page('<input type="checkbox" aria-label="Terms">');
    const input = indeterminate.document.querySelector("input");
    if (input === null) throw new Error("fixture missing checkbox");
    Reflect.set(input, "indeterminate", true);
    const indeterminateResult = await executeDomTool(
      tool({ terms: { role: "checkbox", name: "Terms", read: "checked" } }),
      {},
      {
        document: indeterminate.document,
        registrationUrl: URL,
        signal: new AbortController().signal,
      },
    );
    expect(indeterminateResult.content[0]?.text).toBe("DOM tool execution failed.");
  });

  it("handles disabled fieldset inheritance and the first legend exception", async () => {
    const result = await execute(
      '<fieldset disabled><legend><button aria-label="Legend action">Legend</button></legend><button aria-label="Blocked action">Blocked</button></fieldset>',
      {
        legend: { role: "button", name: "Legend action", read: "disabled" },
        blocked: { role: "button", name: "Blocked action", read: "disabled" },
      },
    );
    expect(result.content[0]?.text).toBe(
      '{"legend":{"matched":true,"value":false},"blocked":{"matched":true,"value":true}}',
    );
  });

  it("does not fall back from unsupported explicit roles or unsafe implicit roles", async () => {
    const result = await execute(
      `<button role="menuitem">Continue</button><button role="none">Continue</button>
       <a>Help</a><input type="search" aria-label="Search"><input type="button" value="Pay">`,
      {
        continue: { role: "button", name: "Continue", read: "exists" },
        help: { role: "link", name: "Help", read: "exists" },
        search: { role: "textbox", name: "Search", read: "exists" },
        pay: { role: "button", name: "Pay", read: "exists" },
      },
    );
    expect(result.content[0]?.text).toBe(
      '{"continue":{"matched":false},"help":{"matched":false},"search":{"matched":false},"pay":{"matched":false}}',
    );
  });

  it("fails closed for duplicate aria-labelledby ids and bounded name work", async () => {
    const duplicate = await execute(
      '<span id="label">Continue</span><span id="label">Other</span><button aria-labelledby="label"></button>',
      { continue: { role: "button", name: "Continue", read: "exists" } },
    );
    expect(duplicate.content[0]?.text).toBe("DOM tool execution failed.");

    const duplicateToken = await execute(
      '<span id="label">Continue</span><button aria-labelledby="label label"></button>',
      {
        continue: { role: "button", name: "Continue", read: "exists" },
      },
    );
    expect(duplicateToken.content[0]?.text).toBe("DOM tool execution failed.");

    const hiddenTarget = await execute(
      '<span id="label" hidden>Continue</span><button aria-labelledby="label"></button>',
      {
        continue: { role: "button", name: "Continue", read: "exists" },
      },
    );
    expect(hiddenTarget.content[0]?.text).toBe("DOM tool execution failed.");

    const missingTarget = await execute('<button aria-labelledby="missing"></button>', {
      continue: { role: "button", name: "Continue", read: "exists" },
    });
    expect(missingTarget.content[0]?.text).toBe("DOM tool execution failed.");

    const prunedDuplicate = await execute(
      '<span id="label">Continue</span><div hidden id="label">Other</div><button aria-labelledby="label"></button>',
      { continue: { role: "button", name: "Continue", read: "exists" } },
    );
    expect(prunedDuplicate.content[0]?.text).toBe("DOM tool execution failed.");

    const perName = await execute(`<button>${"<span>X</span>".repeat(256)}</button>`, {
      button: { role: "button", name: "X", read: "exists" },
    });
    expect(perName.content[0]?.text).toBe("DOM tool execution failed.");

    const totalWork = await execute(
      "<main>" + "<button><span><b>X</b></span></button>".repeat(2000) + "</main>",
      {
        button: { role: "button", name: "No match", read: "exists" },
      },
    );
    expect(totalWork.content[0]?.text).toBe("DOM tool execution failed.");

    const hugeText = await execute(`<button>${"x".repeat(513)}</button>`, {
      button: { role: "button", name: "x", read: "exists" },
    });
    expect(hugeText.content[0]?.text).toBe("DOM tool execution failed.");

    const hugeId = await execute(
      `<span id="${"x".repeat(513)}">Continue</span><button>Continue</button>`,
      {
        button: { role: "button", name: "Continue", read: "exists" },
      },
    );
    expect(hugeId.content[0]?.text).toBe("DOM tool execution failed.");

    const deepLabel = await execute(
      "<label>" +
        "<div>".repeat(4001) +
        '<input type="checkbox">' +
        "</div>".repeat(4001) +
        "</label>",
      {
        terms: { role: "checkbox", name: "Terms", read: "exists" },
      },
    );
    expect(deepLabel.content[0]?.text).toBe("DOM tool execution failed.");

    const hugeFieldset = await execute(
      `<fieldset>${"<span></span>".repeat(4001)}<legend>Group</legend></fieldset>`,
      {
        group: { role: "group", name: "Group", read: "exists" },
      },
    );
    expect(hugeFieldset.content[0]?.text).toBe("DOM tool execution failed.");
  });

  it("fails on traversal and serialized-output bounds without truncating", async () => {
    const traversal = await execute("<main>" + "<div></div>".repeat(10_000) + "</main>", {
      missing: { role: "heading", name: "Nothing", read: "exists" },
    });
    expect(traversal.content[0]?.text).toBe("DOM tool execution failed.");

    const candidates = await execute("<main>" + "<button>X</button>".repeat(2001) + "</main>", {
      button: { role: "button", name: "No match", read: "exists" },
    });
    expect(candidates.content[0]?.text).toBe("DOM tool execution failed.");

    vi.spyOn(JSON, "stringify").mockReturnValue("x".repeat(4097));
    const output = await execute("<h1>Status</h1>", {
      status: { role: "heading", name: "Status", read: "exists" },
    });
    expect(output.content[0]?.text).toBe("DOM tool execution failed.");
  });

  it("rejects non-empty runtime input and malformed mutation descriptors", async () => {
    const { document } = page("<button>Continue</button>");
    const input = await executeDomTool(
      tool({ continue: { role: "button", name: "Continue", read: "exists" } }),
      { action: "click" },
      { document, registrationUrl: URL, signal: new AbortController().signal },
    );
    expect(input.content[0]?.text).toBe("DOM tool execution failed.");
  });
});
