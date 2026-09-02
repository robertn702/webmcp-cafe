# Release Security Runbook

Three release trust boundaries exist in this repository.

The extension ZIP workflow (`.github/workflows/release-extension.yml`) re-runs
the test suite on an `extension-v*` tag, builds the ZIP, and creates or updates
the GitHub Release. It pins every action to an immutable full commit SHA and
grants its `GITHUB_TOKEN` `contents: write` only in the one job that uploads
release assets.

The npm publication workflow (`.github/workflows/publish-npm.yml`) re-runs the
test suite on `schema-v*` and `mcp-v*` tags. A schema tag publishes only
`@webmcp-today/schema`; an MCP tag publishes only `@webmcp-today/mcp-bridge`.
It authenticates through GitHub Actions OIDC Trusted Publishing, so no npm token
exists anywhere in the repository or environment, and npm records publish
provenance automatically. The publish job holds only `contents: read` and
`id-token: write`, and every action is pinned to a full commit SHA.

`@webmcp-today/engine` releases are human-run using the maintainer's npm
credentials and the reviewed commands below. They do not use the OIDC workflow,
so the publisher must verify the exact checkout and tarball contents before
approving the command.

## Checksum scope

`SHA256SUMS` lets a downloader check that the ZIP bytes they downloaded match
the ZIP bytes attached to that GitHub Release:

```bash
sha256sum --check --strict --ignore-missing SHA256SUMS
```

It is generated and uploaded by the same workflow as the ZIP. It detects a
corrupt or mismatched download, but is not a detached signature and does not
independently authenticate the publisher. Publisher identity currently relies
on GitHub's repository and release controls. Do not describe this file as a
signature.

Do not add a signing step until there is a separately protected signing key and
a documented way for users to obtain and verify its public key. A signature
published only beside the ZIP would not add an independent trust root.

## npm Trusted Publishing

Cut either a `schema-v<semver>` tag for `@webmcp-today/schema` or an
`mcp-v<semver>` tag for `@webmcp-today/mcp-bridge`, from a reviewed, merged
release commit. The tag version must match the target package version.
`scripts/check-npm-release.mjs` also checks the target package identity,
repository URL, and publish configuration. An MCP release checks both package
identities and requires an exact schema dependency pin, but the pin and schema
package version may differ from the MCP tag version.

When an MCP change updates its schema pin, publish that required schema version
first under a `schema-v<semver>` tag, then cut the `mcp-v<semver>` tag. The MCP
workflow verifies the exact pinned schema version is already public before it
publishes the bridge. This also applies to dry runs: an MCP dry run requires its
pinned schema version to already be public, so only a schema dry run can run
before a new schema release.

Authentication is GitHub Actions OIDC Trusted Publishing. The publish job
mints a short-lived npm identity from GitHub's OIDC on each run; npm records
publish provenance automatically. npm requires a GitHub-hosted runner with npm
CLI 11.5.1 or newer **and Node 22.14.0 or newer**; the workflow pins both
(`npm@11.5.1` installed globally, `actions/setup-node` with Node 24). Its
`setup-node` step deliberately sets no `registry-url`, because the empty
`_authToken` it would write to `~/.npmrc` suppresses npm's OIDC fallback.
Do not add `NODE_AUTH_TOKEN`, an npm token, `--otp`, or a `--provenance` flag
to the publish steps — the trust relationship, not a secret, is the credential.

The workflow refuses `workflow_dispatch` unless it runs from the release tag
itself (`github.ref_type` must be `tag`). That guard is defense in depth only: a
modified copy of the workflow on a branch can remove it, so the authoritative barrier is the `npm-publish`
environment's deployment scope — restrict the environment to deploy **only
from `schema-v*` and `mcp-v*` tags, no branches, with admin bypass disabled** (Settings →
Environments → `npm-publish` → Deployment branches → "Selected branches and
tags"). An unreviewed branch copy of the workflow never reaches the
environment, and the required reviewer is the last line of defense for a
legitimate tag run. Review the exact workflow file being executed before
approving any run.

## Engine publication

Engine releases remain human-run npm publications; do not add the engine to the
automated OIDC workflow until a later, separately reviewed release process
requires it.

For the DOM execution release, publish `@webmcp-today/schema@0.4.0` first, then
confirm it is public before publishing `@webmcp-today/engine@0.2.0` (which pins
that exact runtime dependency). The reviewed commit must be checked out and the
package gate must pass:

```bash
bun run check:engine-package --published-schema
(cd packages/engine && npm publish --dry-run --access public)
```

CI runs the same gate without `--published-schema`, installing locally packed
schema and engine tarballs so an unpublished release pair can be reviewed. The
release-mode flag installs only the engine tarball and requires npm to supply
the pinned schema version that was published first.

The human publisher must be authenticated to npm with permission to publish the
`@webmcp-today` scope and must inspect the dry-run tarball before running this
exact command from `packages/engine`:

```bash
npm publish --access public
```

### One-time npm Trusted Publisher configuration

Configure a Trusted Publisher per package on npmjs.com (the `npm trust` flow if
the installed CLI supports it). The relationship is package-scoped, so do it
for both `@webmcp-today/schema` and `@webmcp-today/mcp-bridge`:

- Provider: GitHub Actions
- Organization/user: `robertn702`
- Repository: `webmcp-today`
- Workflow filename: `publish-npm.yml` — must match exactly, `.yml` and all
- Environment: `npm-publish` — the publish job declares the same
  environment, and npm includes it in the OIDC subject it checks
- Permitted action: `npm publish`

If the workflow filename, environment, owner, or repository in the trust record
ever diverges from the workflow, publishes fail with an OIDC authentication
error. Change the workflow, the npm records, and this runbook together.

## Required GitHub Production Settings

The following are active production requirements. They are repository settings,
not versioned files, so this runbook is the source of record for the required
manual configuration. Verify them before using a release workflow.

1. In **Settings → Actions → General**, retain the default `GITHUB_TOKEN`
   permission as **Read repository contents** and keep **Allow GitHub Actions
   to create and approve pull requests** disabled.
2. In the same Actions settings, change **Actions permissions** from allowing
   all actions to **Allow select actions and reusable workflows**. Permit only
   `actions/*`, `oven-sh/setup-bun`, and `softprops/action-gh-release`; then
   enable **Require actions to be pinned to a full-length commit SHA**. The
   workflows already use full SHAs, with the reviewed release version documented
   on each line. Review Dependabot action updates before merging; adding a new
   action also requires an allowlist update in that same reviewed change.
3. Maintain an active `main` branch ruleset. Require pull requests, require the
   `ci` status check, and block branch deletion and force pushes. Give bypass
   access only to the repository owner or an explicitly designated release
   administrator.
4. Ensure active tag rulesets protect `extension-v*`, `schema-v*`, and
   `mcp-v*` before using this release workflow. Block tag
   creation, updates, and deletion for everyone except the repository owner or
   an explicitly designated release administrator. This prevents an unreviewed
   tag from invoking the release workflows or changing a published tag's source.
   Do not allow force-updating a release tag.
5. Maintain a protected `extension-release` environment with a required reviewer
   and move `WXT_EXTENSION_KEY` there only if the release process can tolerate
   an approval gate. In the same change, add `environment: extension-release`
   to the release job so `vars.WXT_EXTENSION_KEY` resolves from that environment.
   This is a defense in depth measure for the release identity; the release
   workflow remains functional without it.
6. Maintain a protected `npm-publish` environment. Enable **Required reviewers**
   (single release maintainer), **Prevent self-review**, and deselect **Allow
   administrators to bypass configured protection rules**. In **Deployment
   branches → Selected branches and tags**, update the live deployment policy
   from `npm-v*` to **Tag** rules matching `schema-v*` and `mcp-v*`, with no
   branch rules, before using this workflow. The
   npm publish job already declares `environment: npm-publish`, and the npm
   Trusted Publisher records reference the same name. Do not store an npm token
   there; OIDC is the credential path. Approve a run only after inspecting the
   tag, commit, checks, package versions, and intended npm package targets.
7. Trigger a release from a disposable, protected test tag only after the
   rulesets are active. Confirm its run completes tag/version validation,
   typecheck, lint, tests, ZIP generation, checksum verification, and release
   upload. Delete the test release and tag only under the applicable release
   procedure. For npm, exercise the same gates tokenlessly with a
   `workflow_dispatch` `dry-run` onto a disposable `schema-v*` or `mcp-v*` tag
   before the
   first real publish. `npm publish --dry-run` packs (running the `prepack`
   build) without uploading, so it proves checkout, install, the release
   gates, and packaging — but it does **not** exercise the OIDC trust
   relationship, and npm does not verify a Trusted Publisher configuration
   until a real publish attempts authentication. Treat the first real publish
   as the trust verification: publish a single deliberate release, then
   confirm the released package resolves and carries provenance.

After changing these settings, inspect the Actions configuration and rulesets
from the repository UI or API. Do not treat the presence of SHA pins in Git as
proof that GitHub's Actions policy or ref protections are enabled.
