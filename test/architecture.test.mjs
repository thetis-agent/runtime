import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "src");
const layers = {
  contracts: [],
  lib: ["contracts"],
  kernel: ["contracts", "lib"],
  sandbox: ["contracts", "lib"],
  host: ["contracts", "lib", "kernel", "sandbox"],
  door: [],
  "userspace-agent": ["contracts", "lib"],
};

function filesUnder(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return filesUnder(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}

function importsOf(file) {
  const imports = [];
  const tree = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  function visit(node) {
    let specifier;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) specifier = node.moduleSpecifier;
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) specifier = node.arguments[0];
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) specifier = node.argument.literal;
    if (specifier && ts.isStringLiteral(specifier)) imports.push(specifier.text);
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return imports;
}

test("the runtime owns its implementation and public entry point", () => {
  assert.ok(existsSync(join(source, "index.ts")), "runtime/src/index.ts is the library entry point");
  for (const layer of Object.keys(layers)) {
    assert.ok(existsSync(join(source, layer)), `${layer} belongs to runtime/src`);
    assert.ok(!existsSync(join(root, "packages", layer, "package.json")), `${layer} is an internal module, not an extension package`);
  }
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.equal(manifest.name, "@thetis/runtime");
  assert.deepEqual(manifest.dependencies ?? {}, {}, "the runtime has no dependency on an extension or framework");
});

test("internal layers depend downward and never import extension packages", () => {
  for (const file of filesUnder(source)) {
    const layer = relative(source, file).split("/")[0];
    const allowed = layer === "index.ts" ? ["host", "contracts", "lib"] : [layer, ...layers[layer]];
    for (const specifier of importsOf(file)) {
      if (specifier.startsWith("node:")) continue;
      assert.ok(specifier.startsWith("."), `${relative(root, file)} imports external module ${specifier}`);
      const target = relative(source, resolve(dirname(file), specifier));
      assert.ok(!target.startsWith(".."), `${relative(root, file)} reaches outside runtime/src`);
      const dependency = target.split("/")[0];
      assert.ok(allowed.includes(dependency), `${layer} must not depend on ${dependency}: ${relative(root, file)}`);
      if (target === "lib/container.js") {
        assert.ok(["host", "lib", "index.ts"].includes(layer), "IoC resolution belongs in the composition root, not the kernel");
      }
    }
  }
});

test("extensions use public runtime exports instead of reaching into its source", () => {
  for (const entry of readdirSync(join(root, "packages"), { withFileTypes: true })) {
    const directory = join(root, "packages", entry.name, "src");
    if (!entry.isDirectory() || !existsSync(directory)) continue;
    for (const file of filesUnder(directory)) {
      for (const specifier of importsOf(file)) {
        assert.ok(!/^@thetis\/(contracts|lib|kernel|host|sandbox|door|userspace-agent)(\/|$)/.test(specifier), `${file} uses obsolete package ${specifier}`);
        if (specifier === "@thetis/runtime/kernel") assert.equal(entry.name, "gateway-cli", "only the CLI host adapter imports kernel internals");
        if (!specifier.startsWith(".")) continue;
        assert.ok(!resolve(dirname(file), specifier).startsWith(source + "/"), `${file} bypasses the public runtime API`);
      }
    }
  }
});

test("the compiled public API imports without a packages checkout or node_modules", async () => {
  const directory = mkdtempSync(join(tmpdir(), "thetis-library-"));
  try {
    cpSync(join(root, "dist/src"), join(directory, "dist/src"), { recursive: true });
    cpSync(join(root, "package.json"), join(directory, "package.json"));
    writeFileSync(join(directory, "consumer.mjs"), `
      import assert from "node:assert/strict";
      import { createKernel, defaultConfig, Container, T } from "@thetis/runtime";
      import { SYSTEM_USER } from "@thetis/runtime/contracts";
      import { memoryStore } from "@thetis/runtime/lib/store";
      import { createControlHandler } from "@thetis/runtime/kernel";
      import { ProcessFence } from "@thetis/runtime/sandbox";
      import { createDoor } from "@thetis/runtime/door";
      for (const value of [createKernel, defaultConfig, Container, memoryStore, createControlHandler, ProcessFence, createDoor]) {
        assert.equal(typeof value, "function");
      }
      assert.equal(typeof T.fences.key, "symbol");
      assert.equal(typeof SYSTEM_USER, "string");
    `);
    await import(pathToFileURL(join(directory, "consumer.mjs")).href);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
