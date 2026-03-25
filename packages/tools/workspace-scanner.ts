/**
 * workspace-scanner.ts
 *
 * Scans a project workspace and builds a manifest of languages, frameworks,
 * config files, package managers, and entry points.
 * Zero external dependencies - uses Bun native FS APIs.
 *
 * Status: quarantine - not wired into agent tool registry
 */

import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";

export interface WorkspaceManifest {
  rootDir: string;
  packageManagers: string[];
  languages: string[];
  frameworks: string[];
  entryPoints: string[];
  configFiles: string[];
  monorepo: boolean;
  workspaces: string[];
}

const PACKAGE_MANAGER_FILES: Record<string, string> = {
  "package-lock.json": "npm",
  "yarn.lock": "yarn",
  "pnpm-lock.yaml": "pnpm",
  "bun.lockb": "bun",
  "bun.lock": "bun",
  "Pipfile.lock": "pipenv",
  "poetry.lock": "poetry",
  "Cargo.lock": "cargo",
  "go.sum": "go mod",
  "Gemfile.lock": "bundler",
  "composer.lock": "composer",
};

const LANGUAGE_MARKERS: Record<string, string> = {
  "package.json": "TypeScript/JavaScript",
  "tsconfig.json": "TypeScript",
  "Cargo.toml": "Rust",
  "go.mod": "Go",
  "pyproject.toml": "Python",
  "requirements.txt": "Python",
  "setup.py": "Python",
  "Pipfile": "Python",
  "Gemfile": "Ruby",
  "composer.json": "PHP",
  "pom.xml": "Java",
  "build.gradle": "Java/Kotlin",
  "CMakeLists.txt": "C/C++",
  "Makefile": "C/C++",
};

const FRAMEWORK_MARKERS: Record<string, string> = {
  next: "Next.js",
  react: "React",
  vue: "Vue",
  svelte: "Svelte",
  astro: "Astro",
  nuxt: "Nuxt",
  remix: "Remix",
  express: "Express",
  fastify: "Fastify",
  hono: "Hono",
  elysia: "Elysia",
  "@nestjs/core": "NestJS",
  ink: "Ink (TUI)",
  tauri: "Tauri",
  django: "Django",
  flask: "Flask",
  fastapi: "FastAPI",
  rails: "Rails",
  laravel: "Laravel",
};

const CONFIG_EXACT = new Set([
  "tsconfig.json",
  ".eslintrc",
  "eslint.config.js",
  "eslint.config.ts",
  ".prettierrc",
  "prettier.config.js",
  "vite.config.ts",
  "vite.config.js",
  "webpack.config.js",
  "rollup.config.js",
  "tailwind.config.js",
  "tailwind.config.ts",
  "postcss.config.js",
  "docker-compose.yml",
  "docker-compose.yaml",
  "Dockerfile",
  ".env",
  "fly.toml",
  "vercel.json",
  "netlify.toml",
  "biome.json",
  "deno.json",
  "bun.toml",
]);

const CONFIG_PREFIXES = ["tsconfig.", ".eslintrc.", ".prettierrc.", ".env."];

const ENTRY_POINT_CANDIDATES = [
  "index.ts", "index.js", "index.tsx",
  "src/index.ts", "src/index.js", "src/index.tsx",
  "src/main.ts", "src/main.js",
  "src/app.ts", "src/app.js",
  "bin/index.ts", "bin/index.js",
  "main.ts", "main.js", "main.py", "main.go",
  "app.ts", "app.js",
  "server.ts", "server.js",
  "cmd/main.go",
  "src/main.rs",
];

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function readJson(path: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

function unique<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}

export function scanWorkspace(rootDir: string): WorkspaceManifest {
  const entries = listDir(rootDir);
  const packageManagers: string[] = [];
  const languages: string[] = [];
  const frameworks: string[] = [];
  const configFiles: string[] = [];
  const entryPoints: string[] = [];
  const workspaces: string[] = [];

  for (const [file, pm] of Object.entries(PACKAGE_MANAGER_FILES)) {
    if (entries.includes(file)) packageManagers.push(pm);
  }

  for (const [marker, lang] of Object.entries(LANGUAGE_MARKERS)) {
    if (entries.includes(marker)) languages.push(lang);
  }

  const pkgJsonPath = join(rootDir, "package.json");
  let monorepo = false;

  if (existsSync(pkgJsonPath)) {
    const pkg = readJson(pkgJsonPath);
    const deps: Record<string, string> = {
      ...((pkg.dependencies as Record<string, string>) ?? {}),
      ...((pkg.devDependencies as Record<string, string>) ?? {}),
    };
    for (const [dep, fw] of Object.entries(FRAMEWORK_MARKERS)) {
      if (dep in deps) frameworks.push(fw);
    }
    if (pkg.workspaces || entries.includes("pnpm-workspace.yaml")) {
      monorepo = true;
      const ws = pkg.workspaces;
      const globs: string[] = Array.isArray(ws)
        ? ws
        : Array.isArray((ws as Record<string, unknown>)?.packages)
        ? ((ws as Record<string, unknown>).packages as string[])
        : [];
      for (const glob of globs) {
        const base = glob.replace(/\/\*.*$/, "");
        const wsPath = join(rootDir, base);
        if (existsSync(wsPath)) {
          for (const d of listDir(wsPath)) {
            const full = join(wsPath, d);
            try {
              if (statSync(full).isDirectory()) workspaces.push(`${base}/${d}`);
            } catch {}
          }
        }
      }
    }
  }

  for (const entry of entries) {
    if (CONFIG_EXACT.has(entry)) {
      configFiles.push(entry);
    } else if (CONFIG_PREFIXES.some((p) => entry.startsWith(p))) {
      configFiles.push(entry);
    }
  }

  for (const candidate of ENTRY_POINT_CANDIDATES) {
    if (existsSync(join(rootDir, candidate))) entryPoints.push(candidate);
  }

  return {
    rootDir,
    packageManagers: unique(packageManagers),
    languages: unique(languages),
    frameworks: unique(frameworks),
    entryPoints: unique(entryPoints),
    configFiles: unique(configFiles),
    monorepo,
    workspaces: unique(workspaces),
  };
}

if (import.meta.main) {
  const dir = process.argv[2] ?? process.cwd();
  const manifest = scanWorkspace(dir);
  console.log(JSON.stringify(manifest, null, 2));
}
