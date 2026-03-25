/**
 * Project Scaffolder for 8gent
 *
 * Generates new project structures following 8gent conventions.
 * Supports: Bun TypeScript, Next.js app, React component library.
 *
 * Usage:
 *   bun run packages/tools/project-scaffolder.ts <template> <name> [dir]
 *
 * Templates: bun-ts | nextjs | react-lib
 */

import { mkdirSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

export type Template = "bun-ts" | "nextjs" | "react-lib";

export interface ScaffoldOptions {
  template: Template;
  name: string;
  dir?: string;
}

export interface ScaffoldResult {
  root: string;
  files: string[];
}

interface FileEntry {
  path: string;
  content: string;
}

const TEMPLATES: Record<Template, (name: string) => FileEntry[]> = {
  "bun-ts": (name) => [
    { path: "src/index.ts", content: `/**\n * ${name} - entry point\n */\n\nexport function main(): void {\n  console.log("${name} running");\n}\n\nif (import.meta.main) {\n  main();\n}\n` },
    { path: "src/lib.ts", content: `/**\n * ${name} - core library\n */\n\nexport {};\n` },
    { path: "tests/index.test.ts", content: `import { describe, it, expect } from "bun:test";\nimport { main } from "../src/index";\n\ndescribe("${name}", () => {\n  it("should run without error", () => {\n    expect(main).toBeDefined();\n  });\n});\n` },
    { path: "package.json", content: JSON.stringify({ name: `@8gent/${name}`, version: "0.1.0", type: "module", main: "src/index.ts", scripts: { start: "bun run src/index.ts", test: "bun test", lint: "bunx biome check src/" }, devDependencies: { "@types/bun": "latest" } }, null, 2) + "\n" },
    { path: "tsconfig.json", content: JSON.stringify({ compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "bundler", strict: true, esModuleInterop: true, skipLibCheck: true, outDir: "dist", rootDir: "src", declaration: true, sourceMap: true }, include: ["src"] }, null, 2) + "\n" },
    { path: ".gitignore", content: "node_modules/\ndist/\n.env\n.env.local\n" },
  ],

  "nextjs": (name) => [
    { path: "src/app/layout.tsx", content: `export const metadata = { title: "${name}" };\n\nexport default function RootLayout({ children }: { children: React.ReactNode }) {\n  return (\n    <html lang="en">\n      <body>{children}</body>\n    </html>\n  );\n}\n` },
    { path: "src/app/page.tsx", content: `export default function Home() {\n  return (\n    <main>\n      <h1>${name}</h1>\n    </main>\n  );\n}\n` },
    { path: "src/app/globals.css", content: `*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }\n\nbody {\n  font-family: Inter, system-ui, sans-serif;\n  -webkit-font-smoothing: antialiased;\n}\n` },
    { path: "public/.gitkeep", content: "" },
    { path: "package.json", content: JSON.stringify({ name: `@8gent/${name}`, version: "0.1.0", private: true, scripts: { dev: "next dev --turbopack", build: "next build", start: "next start", lint: "next lint" }, dependencies: { next: "latest", react: "latest", "react-dom": "latest" }, devDependencies: { "@types/react": "latest", "@types/react-dom": "latest", typescript: "latest" } }, null, 2) + "\n" },
    { path: "tsconfig.json", content: JSON.stringify({ compilerOptions: { target: "ES2022", lib: ["dom", "dom.iterable", "esnext"], allowJs: true, skipLibCheck: true, strict: true, noEmit: true, esModuleInterop: true, module: "ESNext", moduleResolution: "bundler", resolveJsonModule: true, jsx: "preserve", incremental: true, plugins: [{ name: "next" }], paths: { "@/*": ["./src/*"] } }, include: ["next-env.d.ts", "**/*.ts", "**/*.tsx"], exclude: ["node_modules"] }, null, 2) + "\n" },
    { path: "next.config.ts", content: `import type { NextConfig } from "next";\n\nconst config: NextConfig = {};\n\nexport default config;\n` },
    { path: ".gitignore", content: "node_modules/\n.next/\nout/\n.env\n.env.local\n" },
  ],

  "react-lib": (name) => [
    { path: "src/index.ts", content: `/**\n * ${name} - React component library\n */\n\nexport { Button } from "./components/Button";\n` },
    { path: "src/components/Button.tsx", content: `import type { ButtonHTMLAttributes } from "react";\n\nexport interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {\n  variant?: "primary" | "secondary";\n}\n\nexport function Button({ variant = "primary", children, ...props }: ButtonProps) {\n  return (\n    <button data-variant={variant} {...props}>\n      {children}\n    </button>\n  );\n}\n` },
    { path: "tests/Button.test.tsx", content: `import { describe, it, expect } from "bun:test";\nimport { Button } from "../src";\n\ndescribe("Button", () => {\n  it("should be defined", () => {\n    expect(Button).toBeDefined();\n  });\n});\n` },
    { path: "package.json", content: JSON.stringify({ name: `@8gent/${name}`, version: "0.1.0", type: "module", main: "dist/index.js", types: "dist/index.d.ts", files: ["dist"], scripts: { build: "bun build src/index.ts --outdir dist --target browser", test: "bun test", lint: "bunx biome check src/" }, peerDependencies: { react: ">=18", "react-dom": ">=18" }, devDependencies: { "@types/react": "latest", "@types/react-dom": "latest", typescript: "latest" } }, null, 2) + "\n" },
    { path: "tsconfig.json", content: JSON.stringify({ compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "bundler", strict: true, esModuleInterop: true, skipLibCheck: true, jsx: "react-jsx", outDir: "dist", rootDir: "src", declaration: true, sourceMap: true }, include: ["src"] }, null, 2) + "\n" },
    { path: ".gitignore", content: "node_modules/\ndist/\n.env\n.env.local\n" },
  ],
};

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

export function scaffold(options: ScaffoldOptions): ScaffoldResult {
  const { template, name, dir } = options;
  const root = dir ?? join(process.cwd(), name);

  if (existsSync(root)) {
    throw new Error(`Directory already exists: ${root}`);
  }

  const generator = TEMPLATES[template];
  if (!generator) {
    throw new Error(`Unknown template: ${template}. Use: ${Object.keys(TEMPLATES).join(", ")}`);
  }

  const entries = generator(name);
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = join(root, entry.path);
    ensureDir(join(fullPath, ".."));
    writeFileSync(fullPath, entry.content, "utf-8");
    files.push(entry.path);
  }

  return { root, files };
}

// CLI entry point
if (import.meta.main) {
  const [template, name, dir] = process.argv.slice(2);

  if (!template || !name) {
    console.log("Usage: bun run project-scaffolder.ts <template> <name> [dir]");
    console.log("Templates: bun-ts | nextjs | react-lib");
    process.exit(1);
  }

  if (!Object.keys(TEMPLATES).includes(template)) {
    console.error(`Unknown template: ${template}`);
    console.error(`Available: ${Object.keys(TEMPLATES).join(", ")}`);
    process.exit(1);
  }

  const result = scaffold({ template: template as Template, name, dir });
  console.log(`Scaffolded ${template} project "${name}" at ${result.root}`);
  console.log(`Files created:\n${result.files.map(f => `  ${f}`).join("\n")}`);
}
