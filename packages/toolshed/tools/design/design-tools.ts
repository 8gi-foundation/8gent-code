/**
 * 8gent Toolshed - Design Tools
 *
 * Design system analysis, component scaffolding,
 * and CSS/styling utilities.
 */

import { registerTool } from "../../registry/register";
import type { ExecutionContext } from "../../../types";
import * as fs from "fs";
import * as path from "path";

// ── analyze_design_system ───────────────────────────

registerTool({
  name: "analyze_design_system",
  description: "Analyze a project's design system: colors, typography, spacing, components, and tokens.",
  capabilities: ["design"],
  inputSchema: {
    type: "object",
    properties: {
      scanPaths: {
        type: "array",
        items: { type: "string" },
        description: "Directories to scan (default: src/)",
      },
    },
  },
  permissions: ["read:code"],
}, async (input: unknown, ctx: ExecutionContext) => {
  const { scanPaths = ["src"] } = input as { scanPaths?: string[] };
  const cwd = ctx.workingDirectory;

  const result: Record<string, any> = {
    framework: "unknown",
    hasDesignTokens: false,
    hasTailwind: false,
    colorCount: 0,
    componentCount: 0,
  };

  // Check for Tailwind
  for (const name of ["tailwind.config.ts", "tailwind.config.js", "tailwind.config.mjs"]) {
    if (fs.existsSync(path.join(cwd, name))) {
      result.hasTailwind = true;
      result.tailwindConfig = name;
      try {
        const content = fs.readFileSync(path.join(cwd, name), "utf-8");
        // Count custom colors
        const colorMatches = content.match(/['"]#[0-9a-fA-F]{3,8}['"]/g);
        if (colorMatches) result.colorCount = colorMatches.length;
        // Check for design tokens
        if (content.includes("colors:") || content.includes("extend:")) {
          result.hasDesignTokens = true;
        }
      } catch {}
      break;
    }
  }

  // Check for CSS variables (design tokens)
  const globalCss = path.join(cwd, "src", "app", "globals.css");
  const altCss = path.join(cwd, "src", "index.css");
  const cssPath = fs.existsSync(globalCss) ? globalCss : fs.existsSync(altCss) ? altCss : null;
  if (cssPath) {
    const css = fs.readFileSync(cssPath, "utf-8");
    const customProps = css.match(/--[\w-]+:/g);
    if (customProps) {
      result.hasDesignTokens = true;
      result.customProperties = customProps.length;
    }
  }

  // Count components
  const componentDirs = ["components", "ui", "shared", "atoms", "molecules", "organisms"];
  for (const dir of componentDirs) {
    for (const scanPath of scanPaths) {
      const fullDir = path.join(cwd, scanPath, dir);
      if (fs.existsSync(fullDir)) {
        try {
          const files = fs.readdirSync(fullDir, { recursive: true }) as string[];
          const components = files.filter((f: string) =>
            f.endsWith(".tsx") || f.endsWith(".vue") || f.endsWith(".svelte")
          );
          result.componentCount += components.length;
          result.componentDir = path.join(scanPath, dir);
        } catch {}
      }
    }
  }

  // Check for UI library
  const pkgPath = path.join(cwd, "package.json");
  if (fs.existsSync(pkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
    const uiLibs: string[] = [];
    const knownLibs = [
      "shadcn-ui", "@radix-ui/react-dialog", "@headlessui/react",
      "@chakra-ui/react", "@mui/material", "antd", "@mantine/core",
      "daisyui", "@nextui-org/react",
    ];
    for (const lib of knownLibs) {
      if (allDeps[lib]) uiLibs.push(lib);
    }
    if (uiLibs.length) result.uiLibraries = uiLibs;
  }

  return result;
});

// ── scaffold_component ──────────────────────────────

registerTool({
  name: "scaffold_component",
  description: "Generate a React/Vue/Svelte component scaffold with proper patterns for the project's stack.",
  capabilities: ["design", "design.component"],
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Component name (PascalCase)" },
      type: { type: "string", description: "Component type: page, layout, ui, feature, form" },
      framework: { type: "string", description: "Framework: react, vue, svelte (auto-detected if omitted)" },
      withTest: { type: "boolean", description: "Include test file" },
      withStory: { type: "boolean", description: "Include Storybook story" },
    },
    required: ["name"],
  },
  permissions: ["write:code"],
}, async (input: unknown, ctx: ExecutionContext) => {
  const { name, type = "ui", framework, withTest, withStory } = input as {
    name: string; type?: string; framework?: string; withTest?: boolean; withStory?: boolean;
  };

  const cwd = ctx.workingDirectory;

  // Auto-detect framework
  let fw = framework || "react";
  if (!framework) {
    const pkgPath = path.join(cwd, "package.json");
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps["vue"]) fw = "vue";
      else if (deps["svelte"]) fw = "svelte";
    }
  }

  // Determine output directory
  const dirMap: Record<string, string> = {
    ui: "src/components/ui",
    page: "src/app",
    layout: "src/components/layout",
    feature: "src/features",
    form: "src/components/forms",
  };
  const outDir = path.join(cwd, dirMap[type] || "src/components");
  fs.mkdirSync(outDir, { recursive: true });

  const files: string[] = [];

  if (fw === "react") {
    const content = `"use client";

import { type FC } from "react";

interface ${name}Props {
  className?: string;
}

export const ${name}: FC<${name}Props> = ({ className }) => {
  return (
    <div className={className}>
      <h2>${name}</h2>
    </div>
  );
};

export default ${name};
`;
    const filePath = path.join(outDir, `${name}.tsx`);
    fs.writeFileSync(filePath, content);
    files.push(filePath);

    if (withTest) {
      const testContent = `import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ${name} } from "./${name}";

describe("${name}", () => {
  it("renders without crashing", () => {
    render(<${name} />);
    expect(screen.getByText("${name}")).toBeDefined();
  });
});
`;
      const testPath = path.join(outDir, `${name}.test.tsx`);
      fs.writeFileSync(testPath, testContent);
      files.push(testPath);
    }
  }

  return { framework: fw, files, componentType: type };
});

// ── extract_colors ──────────────────────────────────

registerTool({
  name: "extract_colors",
  description: "Extract all color values from CSS/SCSS/Tailwind config files in the project.",
  capabilities: ["design"],
  inputSchema: {
    type: "object",
    properties: {},
  },
  permissions: ["read:code"],
}, async (_input: unknown, ctx: ExecutionContext) => {
  const cwd = ctx.workingDirectory;
  const colors = new Map<string, string[]>(); // color -> files where used

  function scanFile(filePath: string) {
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      const relativePath = path.relative(cwd, filePath);

      // Hex colors
      const hexes = content.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
      for (const hex of hexes) {
        const normalized = hex.toLowerCase();
        if (!colors.has(normalized)) colors.set(normalized, []);
        if (!colors.get(normalized)!.includes(relativePath)) {
          colors.get(normalized)!.push(relativePath);
        }
      }

      // CSS variables that look like colors
      const vars = content.match(/--[\w-]*color[\w-]*:\s*[^;]+/gi) || [];
      for (const v of vars) {
        if (!colors.has(v.trim())) colors.set(v.trim(), []);
        colors.get(v.trim())!.push(relativePath);
      }
    } catch {}
  }

  function walkDir(dir: string, depth = 0) {
    if (depth > 3) return;
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walkDir(full, depth + 1);
        } else if (/\.(css|scss|less|tsx?|vue|svelte)$/.test(entry.name)) {
          scanFile(full);
        }
      }
    } catch {}
  }

  // Also scan tailwind config
  for (const name of ["tailwind.config.ts", "tailwind.config.js"]) {
    const p = path.join(cwd, name);
    if (fs.existsSync(p)) scanFile(p);
  }

  walkDir(path.join(cwd, "src"));

  const sorted = [...colors.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 50)
    .map(([color, files]) => ({ color, usedIn: files.length, files: files.slice(0, 3) }));

  return { totalColors: colors.size, colors: sorted };
});
