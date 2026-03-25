#!/usr/bin/env bun
/**
 * 8gent Monorepo Package Scaffolder
 *
 * Generates boilerplate for packages, apps, benchmarks, and tools.
 * Follows monorepo conventions: packages/* and apps/* with Bun + TypeScript.
 *
 * Usage (CLI):
 *   bun run packages/tools/scaffolder.ts --template package --name my-lib
 *   bun run packages/tools/scaffolder.ts --template app --name my-app
 *   bun run packages/tools/scaffolder.ts --template benchmark --name my-bench
 *   bun run packages/tools/scaffolder.ts --template tool --name my-tool
 *   bun run packages/tools/scaffolder.ts --template package --name my-lib --dry-run
 *
 * Usage (import):
 *   import { scaffold } from "./packages/tools/scaffolder.ts";
 *   await scaffold({ template: "package", name: "my-lib" });
 */

import * as fs from "fs";
import * as path from "path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TemplateKind = "package" | "app" | "benchmark" | "tool";

export interface ScaffoldOptions {
  /** Template kind to generate */
  template: TemplateKind;
  /** Name used for directory and package.json - lowercase, hyphens, numbers only */
  name: string;
  /** Monorepo root. Defaults to process.cwd(). */
  root?: string;
  /** Preview without writing any files */
  dryRun?: boolean;
}

export interface ScaffoldResult {
  dir: string;
  files: string[];
  dryRun: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toPascal(name: string): string {
  return name.split("-").map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join("");
}

function toCamel(name: string): string {
  const p = toPascal(name);
  return p.charAt(0).toLowerCase() + p.slice(1);
}

function makePackageJson(name: string, description: string, extra: object = {}): string {
  return JSON.stringify(
    {
      name: `@8gent/${name}`,
      version: "0.1.0",
      description,
      main: "index.ts",
      types: "index.ts",
      type: "module",
      exports: { ".": { import: "./index.ts", types: "./index.ts" } },
      scripts: { typecheck: "tsc --noEmit" },
      devDependencies: { typescript: "^5.3.0" },
      ...extra,
    },
    null,
    2
  );
}

function makeTsconfig(): string {
  return JSON.stringify(
    {
      extends: "../../tsconfig.json",
      compilerOptions: { outDir: "./dist", rootDir: "." },
      include: ["./**/*.ts"],
      exclude: ["node_modules", "dist"],
    },
    null,
    2
  );
}

// ---------------------------------------------------------------------------
// Template: package (lib)
// ---------------------------------------------------------------------------

function buildLibFiles(name: string): Record<string, string> {
  const pascal = toPascal(name);
  return {
    "package.json": makePackageJson(name, `${name} package for 8gent`),
    "tsconfig.json": makeTsconfig(),
    "index.ts": [
      `/**`,
      ` * @8gent/${name} - entry point`,
      ` */`,
      ``,
      `export * from "./${name}";`,
      `export * from "./types";`,
      ``,
    ].join("\n"),
    [`${name}.ts`]: [
      `/**`,
      ` * ${pascal} - core implementation`,
      ` */`,
      ``,
      `import type { ${pascal}Options, ${pascal}Result } from "./types";`,
      ``,
      `export class ${pascal} {`,
      `  private options: ${pascal}Options;`,
      ``,
      `  constructor(options: ${pascal}Options = {}) {`,
      `    this.options = options;`,
      `  }`,
      ``,
      `  async run(input: string): Promise<${pascal}Result> {`,
      `    // TODO: implement`,
      `    return { success: true, output: input };`,
      `  }`,
      `}`,
      ``,
    ].join("\n"),
    "types.ts": [
      `/**`,
      ` * Types for @8gent/${name}`,
      ` */`,
      ``,
      `export interface ${pascal}Options {`,
      `  verbose?: boolean;`,
      `}`,
      ``,
      `export interface ${pascal}Result {`,
      `  success: boolean;`,
      `  output: string;`,
      `  error?: string;`,
      `}`,
      ``,
    ].join("\n"),
    "README.md": `# @8gent/${name}\n\nPart of the [8gent](https://8gent.dev) ecosystem.\n`,
  };
}

// ---------------------------------------------------------------------------
// Template: app (Ink TUI)
// ---------------------------------------------------------------------------

function buildAppFiles(name: string): Record<string, string> {
  const pascal = toPascal(name);
  return {
    "package.json": JSON.stringify(
      {
        name: `@8gent/${name}`,
        version: "0.1.0",
        description: `${name} app`,
        private: true,
        type: "module",
        scripts: {
          start: `bun run src/index.tsx`,
          dev: `bun run src/index.tsx`,
          build: `bun build src/index.tsx --outdir dist --target node`,
          typecheck: "tsc --noEmit",
        },
        dependencies: {
          ink: "^6.8.0",
          react: "^19.0.0",
          "@types/react": "^19.0.0",
        },
        devDependencies: { typescript: "^5.3.0" },
      },
      null,
      2
    ),
    "tsconfig.json": makeTsconfig(),
    "src/index.tsx": [
      `#!/usr/bin/env bun`,
      `import React from "react";`,
      `import { render } from "ink";`,
      `import { App } from "./App";`,
      ``,
      `render(<App />);`,
      ``,
    ].join("\n"),
    "src/App.tsx": [
      `import React from "react";`,
      `import { Box, Text } from "ink";`,
      ``,
      `export const App: React.FC = () => (`,
      `  <Box flexDirection="column" padding={1}>`,
      `    <Text bold color="cyan">${pascal} is running.</Text>`,
      `  </Box>`,
      `);`,
      ``,
    ].join("\n"),
    "README.md": `# ${name}\n\nApp in the [8gent](https://8gent.dev) monorepo.\n`,
  };
}

// ---------------------------------------------------------------------------
// Template: benchmark
// ---------------------------------------------------------------------------

function buildBenchmarkFiles(name: string): Record<string, string> {
  const pascal = toPascal(name);
  const camel = toCamel(name);
  const constId = name.toUpperCase().replace(/-/g, "_");
  return {
    "index.ts": [
      `/**`,
      ` * ${pascal} benchmark suite`,
      ` *`,
      ` * Usage: bun run benchmarks/categories/${name}/index.ts`,
      ` */`,
      ``,
      `import type { BenchmarkDefinition } from "../../types";`,
      ``,
      `export const ${camel}Benchmarks: BenchmarkDefinition[] = [`,
      `  {`,
      `    id: "${constId}_001",`,
      `    name: "${pascal} - Basic",`,
      `    category: "${name}",`,
      `    difficulty: "easy",`,
      `    prompt: "TODO: describe the task",`,
      `    expectedBehavior: "TODO: what a correct response looks like",`,
      `    tags: ["${name}"],`,
      `  },`,
      `];`,
      ``,
      `if (import.meta.main) {`,
      `  console.log(\`\${${camel}Benchmarks.length} benchmarks in ${name}\`);`,
      `  for (const b of ${camel}Benchmarks) console.log(\`  [\${b.id}] \${b.name}\`);`,
      `}`,
      ``,
    ].join("\n"),
    "README.md": `# ${name} benchmarks\n\nBenchmark suite for the ${name} category.\n`,
  };
}

// ---------------------------------------------------------------------------
// Template: tool
// ---------------------------------------------------------------------------

function buildToolFile(name: string): Record<string, string> {
  const pascal = toPascal(name);
  const camel = toCamel(name);
  return {
    [`${name}.ts`]: [
      `/**`,
      ` * ${pascal} tool`,
      ` *`,
      ` * Callable by any agent or directly via CLI.`,
      ` * Usage: bun run packages/tools/${name}.ts [args]`,
      ` */`,
      ``,
      `export interface ${pascal}Input {`,
      `  value: string;`,
      `}`,
      ``,
      `export interface ${pascal}Output {`,
      `  result: string;`,
      `  ok: boolean;`,
      `}`,
      ``,
      `export async function ${camel}(input: ${pascal}Input): Promise<${pascal}Output> {`,
      `  // TODO: implement`,
      `  return { result: input.value, ok: true };`,
      `}`,
      ``,
      `if (import.meta.main) {`,
      `  const value = process.argv.slice(2).join(" ") || "hello";`,
      `  console.log(JSON.stringify(await ${camel}({ value }), null, 2));`,
      `}`,
      ``,
    ].join("\n"),
  };
}

// ---------------------------------------------------------------------------
// File map routing
// ---------------------------------------------------------------------------

function buildFileMap(template: TemplateKind, name: string): Record<string, string> {
  switch (template) {
    case "package":   return buildLibFiles(name);
    case "app":       return buildAppFiles(name);
    case "benchmark": return buildBenchmarkFiles(name);
    case "tool":      return buildToolFile(name);
    default:          throw new Error(`Unknown template: ${template}`);
  }
}

function resolveDestDir(template: TemplateKind, name: string, root: string): string {
  switch (template) {
    case "package":   return path.join(root, "packages", name);
    case "app":       return path.join(root, "apps", name);
    case "benchmark": return path.join(root, "benchmarks", "categories", name);
    case "tool":      return path.join(root, "packages", "tools");
    default:          throw new Error(`Unknown template: ${template}`);
  }
}

// ---------------------------------------------------------------------------
// scaffold() - main export
// ---------------------------------------------------------------------------

export async function scaffold(options: ScaffoldOptions): Promise<ScaffoldResult> {
  const { template, name, dryRun = false } = options;
  const root = options.root ?? process.cwd();

  if (!name || !/^[a-z0-9-]+$/.test(name)) {
    throw new Error(
      `Invalid name "${name}". Use lowercase letters, numbers, and hyphens only.`
    );
  }

  const fileMap = buildFileMap(template, name);
  const destDir = resolveDestDir(template, name, root);

  if (template !== "tool" && !dryRun && fs.existsSync(destDir)) {
    throw new Error(`Destination already exists: ${destDir}`);
  }

  const writtenFiles: string[] = [];

  for (const [relPath, content] of Object.entries(fileMap)) {
    const absPath = path.join(destDir, relPath);
    if (!dryRun) {
      fs.mkdirSync(path.dirname(absPath), { recursive: true });
      fs.writeFileSync(absPath, content, "utf8");
    }
    writtenFiles.push(relPath);
  }

  if (!dryRun) {
    const label =
      template === "tool"
        ? path.join(destDir, Object.keys(fileMap)[0])
        : destDir;
    console.log(`Scaffolded ${template} "${name}" -> ${label}`);
    for (const f of writtenFiles) console.log(`  + ${f}`);
  }

  return { dir: destDir, files: writtenFiles, dryRun };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    if (arg?.startsWith("--") && next && !next.startsWith("--")) {
      flags[arg.replace(/^--/, "")] = next;
      i++;
    }
  }

  const template = flags["template"] as TemplateKind | undefined;
  const name = flags["name"];
  const dryRun = args.includes("--dry-run");

  if (!template || !name) {
    console.error(
      "Usage: bun run packages/tools/scaffolder.ts --template <package|app|benchmark|tool> --name <name> [--dry-run]"
    );
    process.exit(1);
  }

  const valid: TemplateKind[] = ["package", "app", "benchmark", "tool"];
  if (!valid.includes(template)) {
    console.error(`Invalid template "${template}". Choose: ${valid.join(", ")}`);
    process.exit(1);
  }

  try {
    const result = await scaffold({ template, name, dryRun });
    if (dryRun) {
      console.log(`[dry-run] Would scaffold ${template} "${name}" in: ${result.dir}`);
      for (const f of result.files) console.log(`  + ${f}`);
    }
  } catch (err: unknown) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
