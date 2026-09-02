import { describe, expect, it } from "vitest";
import {
  apiAuthSourceSchema,
  apiBlockSchema,
  apiEndpointSchema,
  createPackageSchema,
  publishVersionSchema,
} from "../src/index.js";

// A Reddit-style tier-1 config: REST read (subredditHot) + write (comment with
// the csrf modhash token source) + a GraphQL endpoint exercising errorPath
// and an @documents reference. Cloned + mutated per failure test.
const base = {
  version: 1,
  domain: "reddit.com",
  urlPatterns: ["*://*.reddit.com/*"],
  title: "Reddit API tools",
  description: "Read and write Reddit via its JSON API.",
  minEngine: 1,
  api: {
    baseUrl: "https://www.reddit.com",
    auth: {
      // No ttlSeconds: omitted means "re-fetch every request", the safe default.
      csrf: {
        source: { endpoint: "me", extract: ["data", "modhash"] },
        sendAs: { in: "header", name: "X-Modhash" },
      },
    },
    endpoints: {
      me: { method: "GET", path: "/api/me.json" },
      subredditHot: {
        method: "GET",
        path: "/r/{{subreddit}}/hot.json",
        query: { limit: "{{limit}}" },
        returns: "data.children[].data.{title: title, author: author, score: score}",
      },
      comment: {
        method: "POST",
        path: "/api/comment",
        form: { thing_id: "{{thingId}}", text: "{{text}}", api_type: "json" },
        auth: ["csrf"],
        errorPath: ["json", "errors"],
      },
      searchGraphql: {
        method: "POST",
        path: "/svc/shreddit/graphql",
        graphql: { document: "@documents/search", variables: { query: "{{query}}", first: 10 } },
        errorPath: ["errors"],
        returns: "data.search",
      },
    },
    documents: {
      search: "query Search($query: String!, $first: Int) { search { docCount } }",
    },
  },
  tools: [
    {
      name: "reddit_subreddit_hot",
      description: "List hot posts in a subreddit.",
      inputSchema: {
        type: "object",
        properties: {
          subreddit: { type: "string", description: "Subreddit name" },
          limit: { type: "integer", description: "Max posts" },
        },
        required: ["subreddit"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
      execution: { mode: "api", endpoint: "subredditHot" },
    },
    {
      name: "reddit_comment",
      description: "Post a comment on a post or reply.",
      inputSchema: {
        type: "object",
        properties: {
          thingId: { type: "string", description: "Fullname, e.g. t3_abc" },
          text: { type: "string", description: "Comment body" },
        },
        required: ["thingId", "text"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false },
      execution: { mode: "api", endpoint: "comment" },
    },
    {
      name: "reddit_search",
      description: "Search Reddit.",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string", description: "Search query" } },
        required: ["query"],
        additionalProperties: false,
      },
      execution: { mode: "api", endpoint: "searchGraphql" },
    },
  ],
};

describe("api block cross-validation", () => {
  it("accepts a valid Reddit-style REST + GraphQL config", () => {
    expect(createPackageSchema.safeParse(base).success).toBe(true);
  });

  it("rejects an {{placeholder}} that names no inputSchema property", () => {
    const c = structuredClone(base);
    c.api.endpoints.subredditHot.query.limit = "{{limitz}}";
    expect(createPackageSchema.safeParse(c).success).toBe(false);
  });

  it("rejects a tool bound to an endpoint that does not exist", () => {
    const c = structuredClone(base);
    const tool = c.tools[0];
    if (!tool) throw new Error("fixture missing tool");
    tool.execution = { mode: "api", endpoint: "doesNotExist" };
    expect(createPackageSchema.safeParse(c).success).toBe(false);
  });

  it("rejects an endpoint auth ref that names no auth token source", () => {
    const c = structuredClone(base);
    c.api.endpoints.comment.auth = ["nope"];
    expect(createPackageSchema.safeParse(c).success).toBe(false);
  });

  it("rejects an @documents ref that names no defined document", () => {
    const c = structuredClone(base);
    c.api.endpoints.searchGraphql.graphql.document = "@documents/missing";
    expect(createPackageSchema.safeParse(c).success).toBe(false);
  });

  it("rejects a baseUrl outside the visible package domain", () => {
    const c = structuredClone(base);
    c.api.baseUrl = "https://evil.example.com";
    expect(createPackageSchema.safeParse(c).success).toBe(false);
  });

  it("allows anonymous GET endpoints at an explicitly declared public origin", () => {
    const c = structuredClone(base);
    Object.assign(c.api.endpoints.subredditHot, { baseUrl: "https://hacker-news.firebaseio.com" });
    expect(createPackageSchema.safeParse(c).success).toBe(true);
  });

  it("rejects cross-origin writes, authenticated reads, and cross-origin auth sources", () => {
    const write = structuredClone(base);
    Object.assign(write.api.endpoints.comment, { baseUrl: "https://hacker-news.firebaseio.com" });
    expect(createPackageSchema.safeParse(write).success).toBe(false);

    const authenticatedRead = structuredClone(base);
    Object.assign(authenticatedRead.api.endpoints.subredditHot, {
      baseUrl: "https://hacker-news.firebaseio.com",
      auth: ["csrf"],
    });
    expect(createPackageSchema.safeParse(authenticatedRead).success).toBe(false);

    const tokenSource = structuredClone(base);
    Object.assign(tokenSource.api.endpoints.me, { baseUrl: "https://hacker-news.firebaseio.com" });
    expect(createPackageSchema.safeParse(tokenSource).success).toBe(false);
  });

  it("does not flag {{placeholders}} inside the opaque documents block", () => {
    const c = structuredClone(base);
    c.api.documents.search = "query { {{notAProp}} }";
    expect(createPackageSchema.safeParse(c).success).toBe(true);
  });

  it("does not scan an inline graphql.document string (opaque)", () => {
    const c = structuredClone(base);
    c.api.endpoints.searchGraphql.graphql.document = "query { {{notAProp}} }";
    expect(createPackageSchema.safeParse(c).success).toBe(true);
  });

  it("scans body templates (rejects unknown, accepts valid)", () => {
    const withBody = (body: Record<string, string>) => ({
      version: 1,
      domain: "acme.com",
      urlPatterns: ["*://acme.com/*"],
      title: "x",
      description: "x",
      minEngine: 1,
      api: {
        baseUrl: "https://acme.com",
        endpoints: { create: { method: "POST", path: "/api/create", body } },
      },
      tools: [
        {
          name: "create_thing",
          description: "Create a thing.",
          inputSchema: {
            type: "object",
            properties: { title: { type: "string", description: "Title" } },
            required: ["title"],
            additionalProperties: false,
          },
          execution: { mode: "api", endpoint: "create" },
        },
      ],
    });
    expect(createPackageSchema.safeParse(withBody({ title: "{{bogus}}" })).success).toBe(false);
    expect(createPackageSchema.safeParse(withBody({ title: "{{title}}" })).success).toBe(true);
  });

  it("rejects a non-https baseUrl", () => {
    const c = structuredClone(base);
    c.api.baseUrl = "http://www.reddit.com";
    expect(createPackageSchema.safeParse(c).success).toBe(false);
  });

  it("returns validation issues for malformed primary and unapproved public-read origins", () => {
    const malformed = structuredClone(base);
    malformed.api.baseUrl = "not a URL";
    expect(() => createPackageSchema.safeParse(malformed)).not.toThrow();
    expect(createPackageSchema.safeParse(malformed).success).toBe(false);

    const unapprovedOrigin = structuredClone(base);
    Object.assign(unapprovedOrigin.api.endpoints.subredditHot, {
      baseUrl: "https://api.github.com",
    });
    expect(createPackageSchema.safeParse(unapprovedOrigin).success).toBe(false);
  });

  it("rejects an auth source that fetches from an undefined endpoint", () => {
    const c = structuredClone(base);
    c.api.auth.csrf.source.endpoint = "ghost";
    expect(createPackageSchema.safeParse(c).success).toBe(false);
  });

  it("rejects an endpoint declaring more than one request body kind", () => {
    // The executor resolves graphql > form > body by precedence, so an
    // ambiguous endpoint would publish clean and then send the wrong thing.
    const withBodies = (extra: Record<string, unknown>) => {
      const c = structuredClone(base);
      Object.assign(c.api.endpoints.comment, extra);
      return createPackageSchema.safeParse(c).success;
    };
    // `comment` already declares `form`; exactly one is fine (the base fixture
    // and the body-template test below both cover the single-kind cases).
    expect(withBodies({ body: { text: "{{text}}" } })).toBe(false);
    expect(withBodies({ graphql: { document: "query { a }" } })).toBe(false);
  });

  it("rejects a `returns` that is not a valid JMESPath expression", () => {
    const c = structuredClone(base);
    c.api.endpoints.subredditHot.returns = "data.{unterminated";
    expect(createPackageSchema.safeParse(c).success).toBe(false);
  });

  it("accepts JMESPath the old picker grammar could not express", () => {
    const c = structuredClone(base);
    c.api.endpoints.subredditHot.returns =
      "data.children[?data.score > `50`].data.{title: title, score: score}";
    expect(createPackageSchema.safeParse(c).success).toBe(true);
  });

  it("rejects an empty locator array for errorPath / extract", () => {
    const noErrorPath = structuredClone(base);
    noErrorPath.api.endpoints.comment.errorPath = [];
    expect(createPackageSchema.safeParse(noErrorPath).success).toBe(false);

    const noExtract = structuredClone(base);
    noExtract.api.auth.csrf.source.extract = [];
    expect(createPackageSchema.safeParse(noExtract).success).toBe(false);
  });

  it("accepts a positive integer ttlSeconds, rejects zero/negative/fractional/over-max", () => {
    // Omission is covered by the base fixture, which declares no ttlSeconds.
    const withTtl = (ttlSeconds: unknown) => {
      const c = structuredClone(base);
      Object.assign(c.api.auth.csrf, { ttlSeconds });
      return createPackageSchema.safeParse(c).success;
    };
    expect(withTtl(300)).toBe(true);
    expect(withTtl(86400)).toBe(true);
    expect(withTtl(0)).toBe(false);
    expect(withTtl(-60)).toBe(false);
    expect(withTtl(1.5)).toBe(false);
    expect(withTtl(86401)).toBe(false);
  });

  it("accepts header/form/query sendAs locations, rejects anything else", () => {
    const withIn = (location: string) => {
      const c = structuredClone(base);
      Object.assign(c.api.auth.csrf.sendAs, { in: location });
      return createPackageSchema.safeParse(c).success;
    };
    expect(withIn("header")).toBe(true);
    expect(withIn("query")).toBe(true);
    // `form` requires a form body on the endpoint — covered by its own test.
    expect(withIn("cookie")).toBe(false);
  });

  it("accepts a form-field token when the endpoint declares a form body", () => {
    const c = structuredClone(base);
    Object.assign(c.api.auth.csrf.sendAs, { in: "form", name: "hmac" });
    expect(createPackageSchema.safeParse(c).success).toBe(true);
  });

  it("rejects a form-field token on an endpoint with no form body", () => {
    const c = structuredClone(base);
    Object.assign(c.api.auth.csrf.sendAs, { in: "form", name: "hmac" });
    // Point the read tool's endpoint (no form) at the form-token source.
    Object.assign(c.api.endpoints.subredditHot, { auth: ["csrf"] });
    expect(createPackageSchema.safeParse(c).success).toBe(false);
  });

  it("requires exactly one of extract / pattern on an auth source", () => {
    const neither = structuredClone(base);
    // @ts-expect-error fixture surgery — testing the validation, not the type
    delete neither.api.auth.csrf.source.extract;
    expect(createPackageSchema.safeParse(neither).success).toBe(false);

    const both = structuredClone(base);
    Object.assign(both.api.auth.csrf.source, { pattern: 'name="hmac" value="([^"]+)"' });
    expect(createPackageSchema.safeParse(both).success).toBe(false);

    const patternOnly = structuredClone(base);
    // @ts-expect-error fixture surgery — testing the validation, not the type
    delete patternOnly.api.auth.csrf.source.extract;
    Object.assign(patternOnly.api.auth.csrf.source, { pattern: 'name="hmac" value="([^"]+)"' });
    expect(createPackageSchema.safeParse(patternOnly).success).toBe(true);
  });

  it("scans {{placeholders}} in an auth source's pattern and fetch endpoint", () => {
    // An HN-shaped config: the auth source regexes the vote token out of an
    // HTML page that is never bound to a tool directly.
    const hnLike = {
      version: 1,
      domain: "news.ycombinator.com",
      urlPatterns: ["*://news.ycombinator.com/*"],
      title: "HN write tools",
      description: "Vote and comment on HN.",
      minEngine: 1,
      api: {
        baseUrl: "https://news.ycombinator.com",
        auth: {
          voteAuth: {
            source: {
              endpoint: "itemPage",
              pattern: 'vote\\?id={{itemId}}&how=up&auth=([^&"]+)',
            },
            sendAs: { in: "query", name: "auth" },
          },
        },
        endpoints: {
          itemPage: { method: "GET", path: "/item", query: { id: "{{itemId}}" } },
          vote: {
            method: "GET",
            path: "/vote",
            query: { id: "{{itemId}}", how: "{{how}}" },
            auth: ["voteAuth"],
          },
        },
      },
      tools: [
        {
          name: "hn_vote",
          description: "Vote on an item.",
          inputSchema: {
            type: "object",
            properties: {
              itemId: { type: "string", description: "Item ID" },
              how: { type: "string", description: "up/un" },
            },
            required: ["itemId", "how"],
            additionalProperties: false,
          },
          execution: { mode: "api", endpoint: "vote" },
        },
      ],
    };
    expect(createPackageSchema.safeParse(hnLike).success).toBe(true);

    // A pattern placeholder no tool prop supplies must fail — even though the
    // pattern lives in api.auth, not on a tool-bound endpoint.
    const broken = structuredClone(hnLike);
    broken.api.auth.voteAuth.source.pattern = "vote\\?id={{itemIdZ}}&auth=([0-9a-f]+)";
    expect(createPackageSchema.safeParse(broken).success).toBe(false);

    // Same for a placeholder on the source's fetch endpoint (never tool-bound).
    const brokenEndpoint = structuredClone(hnLike);
    brokenEndpoint.api.endpoints.itemPage.query = { id: "{{itemIdZ}}" };
    expect(createPackageSchema.safeParse(brokenEndpoint).success).toBe(false);
  });

  it("rejects a tool whose execution.mode is an unknown discriminator", () => {
    const result = createPackageSchema.safeParse({
      version: 1,
      domain: "reddit.com",
      urlPatterns: ["*://*.reddit.com/*"],
      title: "x",
      description: "x",
      api: {
        baseUrl: "https://www.reddit.com",
        endpoints: { me: { method: "GET", path: "/api/me.json" } },
      },
      tools: [
        {
          name: "bogus",
          description: "Unknown execution mode.",
          inputSchema: { type: "object", properties: {}, required: [] },
          execution: { mode: "bogus" },
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("runs the same api cross-validation on publishVersionSchema", () => {
    const version = {
      version: 2,
      urlPatterns: base.urlPatterns,
      tools: base.tools,
      api: base.api,
      minEngine: base.minEngine,
    };
    expect(publishVersionSchema.safeParse(version).success).toBe(true);
    const apiSubdomain = structuredClone(version);
    apiSubdomain.urlPatterns = ["*://reddit.com/*"];
    apiSubdomain.api.baseUrl = "https://api.reddit.com";
    expect(publishVersionSchema.safeParse(apiSubdomain).success).toBe(true);
    const broken = structuredClone(version);
    const tool = broken.tools[0];
    if (!tool) throw new Error("fixture missing tool");
    tool.execution = { mode: "api", endpoint: "ghost" };
    expect(publishVersionSchema.safeParse(broken).success).toBe(false);
  });
});

describe("apiEndpointSchema path validation", () => {
  const withPath = (path: string) => apiEndpointSchema.safeParse({ method: "GET", path }).success;

  it("accepts a single-rooted path", () => {
    expect(withPath("/api/me.json")).toBe(true);
  });

  it("rejects a path missing the leading slash", () => {
    expect(withPath("api/me.json")).toBe(false);
  });

  it("rejects a double-slash anywhere in the path", () => {
    expect(withPath("/api//me.json")).toBe(false);
  });

  it("rejects a protocol-relative path", () => {
    expect(withPath("//evil.example.com/api")).toBe(false);
  });

  it("rejects an absolute URL as a path", () => {
    expect(withPath("https://evil.example.com/api")).toBe(false);
  });

  it("rejects a backslash in the path", () => {
    expect(withPath("/api\\me.json")).toBe(false);
  });

  it("rejects an embedded query string in the path", () => {
    expect(withPath("/api/me.json?x=1")).toBe(false);
  });

  it("rejects an embedded fragment in the path", () => {
    expect(withPath("/api/me.json#top")).toBe(false);
  });

  it("rejects a '..' path traversal segment", () => {
    expect(withPath("/api/../admin")).toBe(false);
  });

  it("rejects a '.' path segment", () => {
    expect(withPath("/api/./me.json")).toBe(false);
  });

  it("accepts a segment that merely starts with a dot, like a dotfile-shaped name", () => {
    expect(withPath("/api/.well-known/x")).toBe(true);
  });

  it("accepts a filename containing dots, like me.json", () => {
    expect(withPath("/api/me.json")).toBe(true);
  });
});

describe("apiEndpointSchema GET body rejection", () => {
  it("rejects a GET endpoint declaring a body", () => {
    const result = apiEndpointSchema.safeParse({
      method: "GET",
      path: "/api/search",
      body: { q: "{{q}}" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a GET endpoint declaring a form", () => {
    const result = apiEndpointSchema.safeParse({
      method: "GET",
      path: "/api/search",
      form: { q: "{{q}}" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a GET endpoint declaring a graphql operation", () => {
    const result = apiEndpointSchema.safeParse({
      method: "GET",
      path: "/api/search",
      graphql: { document: "query { a }" },
    });
    expect(result.success).toBe(false);
  });

  it("accepts a POST endpoint declaring a body", () => {
    const result = apiEndpointSchema.safeParse({
      method: "POST",
      path: "/api/search",
      body: { q: "{{q}}" },
    });
    expect(result.success).toBe(true);
  });
});

describe("apiAuthSourceSchema pattern validation", () => {
  const withPattern = (pattern: string) =>
    apiAuthSourceSchema.safeParse({
      source: { endpoint: "me", pattern },
      sendAs: { in: "header", name: "X-Token" },
    }).success;

  it("accepts a pattern with a capture group", () => {
    expect(withPattern('name="hmac" value="([^"]+)"')).toBe(true);
  });

  it("accepts the HN pattern with independently optional non-capturing groups", () => {
    expect(withPattern('vote\\?id={{itemId}}&(?:amp;)?how={{how}}&(?:amp;)?auth=([^&"]+)')).toBe(
      true,
    );
  });

  it("accepts a lazy fixed-width quantifier", () => {
    expect(withPattern("^(a{1}?)+$")).toBe(true);
    expect(withPattern("^(a{1,1}?)+$")).toBe(true);
  });

  it("accepts fully bounded nested repetition", () => {
    expect(withPattern("^((ab?){2})$")).toBe(true);
    expect(withPattern("^((a{1,2}){2})$")).toBe(true);
  });

  it("rejects a pattern with no capture group", () => {
    expect(withPattern('name="hmac" value="[^"]+"')).toBe(false);
  });

  it("rejects a pattern that is not valid regex syntax", () => {
    expect(withPattern("(unterminated")).toBe(false);
  });

  it("rejects a nested variable-width repeat", () => {
    expect(withPattern("^((a+)+)$")).toBe(false);
    expect(withPattern("^((a?a?)+)$")).toBe(false);
    expect(withPattern("^((a+){20})$")).toBe(false);
    expect(withPattern("^((a+){2,2})$")).toBe(false);
    expect(withPattern("^((a{0,1})+)$")).toBe(false);
    expect(withPattern("^((a{1,2})+)$")).toBe(false);
  });

  it("accepts a pattern containing a {{param}} placeholder alongside a capture group", () => {
    expect(withPattern("vote\\?id={{itemId}}&auth=([^&]+)")).toBe(true);
  });
});

describe("apiBlockSchema endpoints", () => {
  it("allows an empty endpoints object for DOM-only packages", () => {
    const result = apiBlockSchema.safeParse({
      baseUrl: "https://acme.com",
      endpoints: {},
    });
    expect(result.success).toBe(true);
  });

  it("accepts a single endpoint", () => {
    const result = apiBlockSchema.safeParse({
      baseUrl: "https://acme.com",
      endpoints: { me: { method: "GET", path: "/api/me" } },
    });
    expect(result.success).toBe(true);
  });
});
