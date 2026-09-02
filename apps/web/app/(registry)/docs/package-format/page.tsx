import type { ReactNode } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import examplePackage from "./example-package.json";

export const metadata: Metadata = {
  title: "Package format",
  description:
    "The full reference for a WebMCP Today package: every top-level field, the tool descriptor, the api block, and a complete worked example.",
};

// The example is a real package document, validated against createPackageSchema
// by apps/web/test/package-format-example.test.ts — so a schema change breaks
// the build instead of quietly invalidating what this page tells publishers.
const EXAMPLE_JSON = JSON.stringify(examplePackage, null, 2);

export default function PackageFormatPage() {
  return (
    <div className="max-w-2xl">
      <p className="font-mono text-[11px] tracking-[0.2em] text-brand uppercase">Docs</p>
      <h1 className="mt-3 font-display text-4xl tracking-tight">The package format</h1>
      <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
        A package is one JSON document. It names the site it targets, the tools it registers there,
        and the API metadata they use, which is an inert same-site block for DOM-only packages. Each
        tool declares either an HTTP request or a bounded read-only DOM observation. Nothing in it
        can run arbitrary code in the page: tools are declarations, not scripts. This page covers
        every field. When you&apos;re ready,{" "}
        <Link href="/submit" className="text-foreground underline underline-offset-4">
          paste it into the form
        </Link>
        .
      </p>

      <Section title="The shape">
        <p>
          Every field below is checked before a package is stored. Validation failures come back as
          the zod issue list, keyed by the path that failed.
        </p>
        <div className="mt-5">
          <Field name="version" type="integer ≥ 1 · required">
            Author-declared, not semver. <Code>1</Code> when you create a package; on a new version
            it must be exactly one higher than the current highest, or the API answers{" "}
            <Code>409</Code> with an <Code>expectedVersion</Code>. That makes a publish built on a
            stale copy fail loudly instead of silently replacing a version you never read.
          </Field>
          <Field name="domain" type="string, 1–253 · required">
            The lookup key. Lowercased, and a leading <Code>www.</Code> is stripped. It has to be
            reachable through <Code>urlPatterns</Code>. A domain no pattern covers would publish and
            then never match a page.
          </Field>
          <Field name="urlPatterns" type="string[], 1–20 · required">
            Chrome <Code>@match</Code>-style patterns: <Code>scheme://host/path</Code>. Scheme is{" "}
            <Code>*</Code>, <Code>http</Code>, or <Code>https</Code>; host is <Code>*</Code>,{" "}
            <Code>*.acme.com</Code> (the apex and any subdomain), or an exact hostname; path starts
            with <Code>/</Code> and may contain <Code>*</Code>. Where more than one package matches
            a page, the more specific pattern ranks higher.
          </Field>
          <Field name="title" type="string, 1–200 · required">
            What the registry lists it as.
          </Field>
          <Field name="description" type="string, 1–5000 · required">
            What the package does and what it needs (a login session, a particular page). This is
            what someone reads before deciding to install, so say what the write tools touch.
          </Field>
          <Field name="tools" type="ToolDescriptor[], 1–30 · required">
            The tools registered on a matching page. Names must be unique within the package.
          </Field>
          <Field name="api" type="ApiBlock · required">
            The site&apos;s HTTP surface. API tools bind to endpoints declared here. DOM-only
            packages retain an inert same-site block with <Code>endpoints: &#123;&#125;</Code>.
          </Field>
          <Field name="minEngine" type="integer ≥ 1 · required">
            The capability floor this version needs, like an Android API level. An extension whose
            own level is lower skips the package instead of half-running it. Current level is{" "}
            <Code>2</Code>. DOM observations require level 2.
          </Field>
          <Field name="changelog" type="string, ≤2000 · optional">
            What changed in this version. Shown to installed users deciding whether to move their
            pin.
          </Field>
        </div>
      </Section>

      <Section title="Tools">
        <p>
          A tool is metadata plus a binding. The description and the input schema are the entire
          interface an agent sees, so they carry the weight. An agent picks a tool by reading them
          and nothing else.
        </p>
        <div className="mt-5">
          <Field name="name" type="string, ≤30 · required">
            Starts with a letter; letters, digits, <Code>_</Code> and <Code>-</Code> after that.
            Prefix them so they don&apos;t collide on a page that has its own tools:{" "}
            <Code>notes_search</Code>, not <Code>search</Code>. A tool whose name collides with one
            the site registered itself is skipped; the rest of the package still registers.
          </Field>
          <Field name="description" type="string, ≤500 · required">
            Say what it does, what it returns, and what it needs. Chrome&apos;s guidance is the
            source of the 500, which is enforced here.
          </Field>
          <Field name="inputSchema" type="JSON Schema object · required">
            <Code>{'{ type: "object", properties, required?, additionalProperties: false }'}</Code>.
            Primitive-only and non-recursive: at most 20 properties, each a <Code>string</Code>/
            <Code>number</Code>/<Code>integer</Code>/<Code>boolean</Code> leaf with an optional{" "}
            <Code>description</Code> (≤150), a type-compatible <Code>enum</Code>, and the matching
            bounds (<Code>minLength</Code>/<Code>maxLength</Code> for strings, <Code>minimum</Code>/
            <Code>maximum</Code> for numbers). No nested objects or arrays, and no unknown keys.
            Property names are what <Code>{"{{param}}"}</Code> placeholders in the api block refer
            to.
          </Field>
          <Field name="annotations" type="object · optional">
            Hints for the agent: <Code>readOnlyHint</Code>, <Code>untrustedContentHint</Code>,{" "}
            <Code>destructiveHint</Code>. No unknown keys, and a tool can&apos;t claim both{" "}
            <Code>readOnlyHint</Code> and <Code>destructiveHint</Code>. Mark writes honestly.
          </Field>
          <Field name="execution" type="API or DOM descriptor · required">
            API mode binds the tool to a key in <Code>api.endpoints</Code>. DOM mode declares 1–16
            exact semantic role/name observations and can return only presence or allowed boolean
            states; it has empty input, read-only/untrusted hints, and <Code>minEngine: 2</Code>.
          </Field>
        </div>
      </Section>

      <Section title="The api block">
        <p>
          This is where the format earns its keep. Instead of shipping a script that pokes at the
          DOM, you declare the requests the site&apos;s own front end already makes, and the
          extension derives the call. Everything is data, so a reader can audit a package by reading
          it.
        </p>
        <div className="mt-5">
          <Field name="baseUrl" type="https:// URL · required">
            Its host must be your package <Code>domain</Code> or a subdomain. It need not be covered
            by <Code>urlPatterns</Code> or equal the current page origin. After interpolation, every
            derived request must still match this exact origin. The sole endpoint-level exception is
            Hacker News&apos;s Firebase read API.
          </Field>
          <Field name="endpoints" type="Record<string, ApiEndpoint> · required">
            Named requests. API tools bind to these keys; DOM-only packages use an empty record.
          </Field>
          <Field name="auth" type="Record<string, ApiAuthSource> · optional">
            Named token flows: fetch a page or endpoint, pull a token out of the response, resend it
            on the real call.
          </Field>
          <Field name="documents" type="Record<string, string> · optional">
            Static GraphQL documents, referenced from an endpoint as{" "}
            <Code>&quot;@documents/name&quot;</Code>. Never scanned for placeholders.
          </Field>
        </div>

        <h3 className="mt-8 text-sm font-semibold">An endpoint</h3>
        <div className="mt-3">
          <Field name="method / path" type="required">
            <Code>GET</Code>, <Code>POST</Code>, <Code>PUT</Code>, <Code>PATCH</Code>,{" "}
            <Code>DELETE</Code>, and a path resolved against <Code>baseUrl</Code>. Paths start with
            exactly one <Code>/</Code> and cannot contain <Code>//</Code>, backslashes, queries,
            fragments, or <Code>.</Code>/<Code>..</Code> segments.
          </Field>
          <Field name="baseUrl" type="https:// URL · optional">
            May stay on the primary origin. Its only cross-origin use is the
            <Code>https://hacker-news.firebaseio.com</Code> origin for Hacker News&apos;s anonymous
            <Code>GET</Code> reads. It cannot use <Code>auth</Code>, the executor omits cookies, and
            redirects are rejected.
          </Field>
          <Field name="query" type="Record<string, string> · optional">
            Query parameters. Values may carry <Code>{"{{param}}"}</Code>.
          </Field>
          <Field name="body / form / graphql" type="at most one">
            <Code>body</Code> is a JSON template, <Code>form</Code> is form-encoded fields,{" "}
            <Code>graphql</Code> is <Code>{"{ document, variables }"}</Code>. Declaring two is
            rejected: the executor would pick one and you&apos;d ship a request you never asked for.
            <Code>GET</Code> endpoints cannot declare any of them. A <Code>body</Code> or{" "}
            <Code>graphql.variables</Code> leaf that is exactly one <Code>{"{{param}}"}</Code> keeps
            its type, so a number stays a number.
          </Field>
          <Field name="returns" type="JMESPath expression · optional">
            Reshapes the response into what the agent gets back. Compiled at publish time, so a
            malformed expression is rejected here rather than failing in every user&apos;s browser.
            Project the handful of fields the tool promised; don&apos;t hand back the raw payload.
          </Field>
          <Field name="errorPath" type="string[] · optional">
            A locator: object keys naming one place in the JSON response, e.g.{" "}
            <Code>[&quot;json&quot;, &quot;errors&quot;]</Code>. A non-empty value there means the
            call failed, even on a 200. An array, not a dotted string, so a key containing a dot is
            unambiguous.
          </Field>
          <Field name="stripPrefix" type="string, ≤50 · optional">
            A literal prefix removed before the body is parsed as JSON, for sites that armour
            responses against XSSI, like Google&apos;s <Code>{")]}'"}</Code>. Stripped only when
            present.
          </Field>
          <Field name="auth" type="string[], ≤10 · optional">
            Names of auth sources to attach to this call.
          </Field>
        </div>

        <h3 className="mt-8 text-sm font-semibold">An auth source</h3>
        <div className="mt-3">
          <Field name="source.endpoint" type="required">
            Which endpoint to fetch the token from.
          </Field>
          <Field name="source.extract / pattern" type="exactly one">
            <Code>extract</Code> is a locator into the JSON response, e.g.{" "}
            <Code>[&quot;data&quot;, &quot;modhash&quot;]</Code>. <Code>pattern</Code> is a regex
            over the raw response text, for tokens served in HTML. Capture group 1 is the token, and
            no match is a loud failure. Declaring both, or neither, is rejected. Any{" "}
            <Code>{"{{param}}"}</Code> inside <Code>pattern</Code> is regex-escaped before the regex
            is compiled, so each interpolated value matches literal text.
          </Field>
          <Field name="sendAs" type="{ in, name } · required">
            Where the token goes: <Code>header</Code>, <Code>form</Code>, or <Code>query</Code>,
            under <Code>name</Code>. A <Code>form</Code> token on an endpoint with no form body is
            rejected; the request would go out without its credential.
          </Field>
          <Field name="ttlSeconds" type="integer, 1–86400 · optional">
            How long a fetched token stays usable. Omit it and the token is re-fetched before every
            call, which is the safe default.
          </Field>
        </div>

        <h3 className="mt-8 text-sm font-semibold">Placeholders</h3>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          <Code>{"{{param}}"}</Code> in a path, query value, form field, body leaf, or GraphQL
          variable is substituted from the bound tool&apos;s input. For a tool-bound endpoint, every
          placeholder must name a property of that tool&apos;s <Code>inputSchema</Code>, or the
          package is rejected, which also means a typo can&apos;t reach a user as an empty string.
          The same check covers an auth source&apos;s fetch endpoint (<Code>path</Code>/
          <Code>query</Code> only) and its <Code>pattern</Code>; an endpoint no tool binds to is
          never scanned at all. Paths and mixed templates always interpolate an absent param as an
          empty string. A query or form field is omitted only when its template is exactly{" "}
          <Code>{"{{param}}"}</Code> and that property is absent from the validated input; an
          explicitly supplied empty string, <Code>0</Code>, or <Code>false</Code> stays present. A{" "}
          <Code>body</Code>/<Code>graphql.variables</Code> leaf that is exactly one{" "}
          <Code>{"{{param}}"}</Code> keeps its raw type and yields <Code>undefined</Code> when
          absent, so JSON drops that object property. There is no escape hatch for a literal{" "}
          <Code>{"{{"}</Code> yet.
        </p>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          At invocation, input must be a plain object containing only declared primitive fields and
          must serialize to at most 64 KiB. Invalid input reports validation issues before a
          destructive confirmation or network request.
        </p>
      </Section>

      <Section title="A complete package">
        <p>
          Two tools against a site&apos;s own JSON API: one read, one write that needs a CSRF token
          the site hands out on a different endpoint. This document validates: it is parsed against
          the schema by the test suite, so it can&apos;t drift from the format.
        </p>
        <pre className="mt-4 overflow-x-auto rounded-lg border bg-muted/50 px-3 py-2 font-mono text-xs">
          {EXAMPLE_JSON}
        </pre>
        <p className="mt-4">
          The three curated packages in the repository are the same thing against real sites, and
          cover the awkward cases: Reddit extracts a JSON token into a header, Hacker News scrapes
          its tokens out of HTML with <Code>pattern</Code>, Google Maps needs{" "}
          <Code>stripPrefix</Code> and projects positional arrays.{" "}
          <a
            href="https://github.com/robertn702/webmcp-today/tree/main/packages/curated-packages/data"
            className="text-foreground underline underline-offset-4"
          >
            Read them
          </a>
          .
        </p>
      </Section>

      <Section title="Publishing">
        <p>
          <Link href="/submit" className="text-foreground underline underline-offset-4">
            Paste the JSON
          </Link>{" "}
          or <Code>POST /api/packages</Code> with a Bearer API key. Same schema either way. Nothing
          reviews it; it goes live when it validates.
        </p>
        <p>
          Versions are append-only. A new version is a <Code>POST</Code> to{" "}
          <Code>/api/packages/:id/versions</Code> with <Code>version</Code> set to one above the
          current highest, and only the owner may publish one. <Code>urlPatterns</Code>,{" "}
          <Code>tools</Code>, <Code>api</Code>, <Code>minEngine</Code> and <Code>changelog</Code>{" "}
          are version-scoped and travel with the content. Title and description are package metadata
          and are edited in place; <Code>domain</Code> is immutable once a package is created.
        </p>
        <p>
          Installs pin to a version, so publishing a new one never moves anybody. They update when
          they choose to. That cuts both ways: a version you published is a version someone may
          still be running.{" "}
          <Link href="/terms" className="text-foreground underline underline-offset-4">
            What you grant when you publish
          </Link>{" "}
          is worth reading once.
        </p>
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-12">
      <h2 className="text-lg font-semibold">{title}</h2>
      <div className="mt-3 flex flex-col gap-3 text-sm leading-relaxed text-muted-foreground">
        {children}
      </div>
    </section>
  );
}

function Field({ name, type, children }: { name: string; type: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 border-t py-3 sm:grid-cols-[11rem_1fr] sm:gap-4">
      <div>
        <code className="font-mono text-[0.85em] text-foreground">{name}</code>
        <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">{type}</p>
      </div>
      <div className="text-sm leading-relaxed text-muted-foreground">{children}</div>
    </div>
  );
}

function Code({ children }: { children: ReactNode }) {
  return (
    <code className="rounded bg-muted px-1 py-px font-mono text-[0.85em] text-foreground">
      {children}
    </code>
  );
}
