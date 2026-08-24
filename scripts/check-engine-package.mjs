#!/usr/bin/env bun
/* global console */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const engineDir = join(repoRoot, "packages/engine");
const scratchDir = join(repoRoot, ".scratch");

function fail(message) {
  throw new Error(message);
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.error) fail(`could not run ${command}: ${result.error.message}`);
  if (result.status !== 0) {
    fail(`${command} ${args.join(" ")} failed:\n${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

let tempDir;

try {
  mkdirSync(scratchDir, { recursive: true });
  tempDir = mkdtempSync(join(scratchDir, "check-engine-package-"));
  const packDir = join(tempDir, "pack");
  mkdirSync(packDir);

  const packOutput = run("npm", ["pack", "--json", "--pack-destination", packDir], engineDir);
  const packJsonStart = packOutput.lastIndexOf("\n[");
  const [packed] = JSON.parse(packOutput.slice(packJsonStart === -1 ? 0 : packJsonStart));
  if (!packed?.filename || !Array.isArray(packed.files))
    fail("npm pack did not report a tarball file list");

  const packedFiles = new Set(packed.files.map((file) => file.path));
  const modules = ["index", "api-executor", "engine-gate", "mcp-result", "result"];
  const requiredFiles = [
    "package.json",
    "LICENSE",
    ...modules.flatMap((module) => [`dist/${module}.js`, `dist/${module}.d.ts`]),
  ];
  for (const file of requiredFiles) {
    if (!packedFiles.has(file)) fail(`packed engine tarball is missing ${file}`);
  }
  const unexpectedFiles = [...packedFiles].filter((file) => !requiredFiles.includes(file));
  if (unexpectedFiles.length > 0) {
    fail(`packed engine tarball contains unexpected files: ${unexpectedFiles.join(", ")}`);
  }

  const consumerDir = join(tempDir, "consumer");
  mkdirSync(consumerDir);
  writeFileSync(join(consumerDir, "package.json"), '{"private":true,"type":"module"}\n');
  const tarball = join(packDir, packed.filename);
  run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball], consumerDir);

  const installedPackage = JSON.parse(
    readFileSync(join(consumerDir, "node_modules/@webmcp-today/engine/package.json"), "utf8"),
  );
  if (installedPackage.dependencies?.["@webmcp-today/schema"] !== "0.3.0") {
    fail("packed engine must pin @webmcp-today/schema to 0.3.0");
  }

  const testFile = join(consumerDir, "engine.test.mjs");
  writeFileSync(
    testFile,
    `import { expect, test } from "bun:test";
import { buildRequest, executeApiTool, handleResponse } from "@webmcp-today/engine";

test("exposes the engine package API", () => {
  expect(typeof executeApiTool).toBe("function");
  expect(typeof buildRequest).toBe("function");
  expect(typeof handleResponse).toBe("function");
});
`,
  );
  run("bun", ["test", testFile], consumerDir);

  const typeFile = join(consumerDir, "types.ts");
  const tsconfigFile = join(consumerDir, "tsconfig.json");
  writeFileSync(
    typeFile,
    `import {
  buildRequest,
  executeApiTool,
  handleResponse,
  type ApiToolDescriptor,
  type DerivedRequest,
  type FetchOutcome,
  type McpResult,
  type McpTextContent,
} from "@webmcp-today/engine";

declare const tool: ApiToolDescriptor;
declare const request: DerivedRequest;
declare const outcome: FetchOutcome;
declare const result: McpResult;
declare const content: McpTextContent;
void [buildRequest, executeApiTool, handleResponse, tool, request, outcome, result, content];
`,
  );
  writeFileSync(
    tsconfigFile,
    `${JSON.stringify({
      compilerOptions: {
        lib: ["ES2022", "DOM"],
        module: "NodeNext",
        moduleResolution: "NodeNext",
        noEmit: true,
        strict: true,
        target: "ES2022",
      },
      files: ["types.ts"],
    })}\n`,
  );
  run(
    "bun",
    [join(repoRoot, "node_modules/typescript/bin/tsc"), "--project", tsconfigFile],
    consumerDir,
  );

  const entryPoint = join(consumerDir, "entry.mjs");
  const bundleFile = join(consumerDir, "bundle.js");
  const metafile = join(consumerDir, "meta.json");
  writeFileSync(
    entryPoint,
    'import { executeApiTool } from "@webmcp-today/engine";\nexport { executeApiTool };\n',
  );
  run(
    "bun",
    [
      "build",
      entryPoint,
      "--target=browser",
      "--packages=bundle",
      "--reject-unresolved",
      `--metafile=${metafile}`,
      `--outfile=${bundleFile}`,
    ],
    consumerDir,
  );
  const bundleMetadata = JSON.parse(readFileSync(metafile, "utf8"));
  const outputImports = Object.values(bundleMetadata.outputs).flatMap((output) => output.imports);
  if (outputImports.length > 0) {
    fail(
      `browser bundle contains external imports: ${outputImports.map((entry) => entry.path).join(", ")}`,
    );
  }

  console.log("ok: packed @webmcp-today/engine installs, imports, and bundles for browsers");
} finally {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
}
