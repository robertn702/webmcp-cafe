# Activation report

Run the on-demand report with inclusive UTC dates:

```sh
bun --filter @webmcp-today/web report:activation --from 2026-08-01 --to 2026-08-07
```

It queries Neon for the anonymous aggregate package-definition and heartbeat metrics, plus the
public GitHub releases API and npm downloads API at report time. Nothing from either public API is
stored. GitHub reports current cumulative per-asset download counts, not dated downloads, so the
report includes assets on releases **published within the requested range** and labels that
mixed-window limitation.

All figures are directional: release assets can be re-downloaded, npm counts include CI `npx`
pulls, retries can inflate request counts, and caches can reduce registry fetches. The
package-definition-GETs-per-extension-ZIP-download ratio divides Neon package-definition GETs by
GitHub extension ZIP downloads. It is explicitly mixed-window and directional, not exact
historical conversion.
