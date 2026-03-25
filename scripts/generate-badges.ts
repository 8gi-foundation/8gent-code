#!/usr/bin/env bun
/**
 * generate-badges.ts - Dynamic README badge generator for 8gent Code
 *
 * Scans the repo to count packages, benchmarks, tools, and skills,
 * then outputs shields.io badge URLs as a markdown row.
 *
 * Usage:
 *   bun run scripts/generate-badges.ts
 *   bun run scripts/generate-badges.ts --json   # machine-readable output
 */

import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(import.meta.dir, "..");

// ---------------------------------------------------------------------------
// Counters
// ---------------------------------------------------------------------------

function countDirs(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory()).length;
}

function countToolNames(toolsFile: string): number {
  if (!fs.existsSync(toolsFile)) return 0;
  const src = fs.readFileSync(toolsFile, "utf-8");
  // Each tool is declared with `name: "tool_name"` inside the definitions array
  const matches = src.match(/name:\s*"/g);
  return matches ? matches.length : 0;
}

function readVersion(): string {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(ROOT, "package.json"), "utf-8")
  );
  return pkg.version ?? "0.0.0";
}

function readLicense(): string {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(ROOT, "package.json"), "utf-8")
  );
  return pkg.license ?? "MIT";
}

// ---------------------------------------------------------------------------
// Gather stats
// ---------------------------------------------------------------------------

const version = readVersion();
const license = readLicense();
const packages = countDirs(path.join(ROOT, "packages"));
const benchmarks = countDirs(path.join(ROOT, "benchmarks", "categories"));
const tools = countToolNames(path.join(ROOT, "packages", "eight", "tools.ts"));
const skills = countDirs(path.join(ROOT, "packages", "skills"));

const stats = { version, license, packages, benchmarks, tools, skills };

// ---------------------------------------------------------------------------
// Badge URL builder
// ---------------------------------------------------------------------------

function shieldsBadge(
  label: string,
  message: string | number,
  color: string,
  logo?: string
): string {
  const l = encodeURIComponent(label);
  const m = encodeURIComponent(String(message));
  const base = `https://img.shields.io/badge/${l}-${m}-${color}?style=flat-square`;
  return logo ? `${base}&logo=${logo}` : base;
}

function mdBadge(
  label: string,
  message: string | number,
  color: string,
  logo?: string,
  link?: string
): string {
  const url = shieldsBadge(label, message, color, logo);
  const img = `![${label}](${url})`;
  return link ? `[${img}](${link})` : img;
}

// ---------------------------------------------------------------------------
// Build badge row
// ---------------------------------------------------------------------------

const badges = [
  mdBadge("version", `v${version}`, "E8610A", undefined, "https://8gent.dev"),
  mdBadge("packages", packages, "blue"),
  mdBadge("benchmarks", `${benchmarks} categories`, "green"),
  mdBadge("tools", tools, "cyan"),
  mdBadge("skills", skills, "yellow"),
  mdBadge("license", license, "brightgreen"),
  mdBadge("build", "passing", "brightgreen", "github", "https://github.com/AiJamesSpalding/8gent-code/actions"),
];

const badgeRow = badges.join("\n");

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

const jsonMode = process.argv.includes("--json");

if (jsonMode) {
  console.log(JSON.stringify({ ...stats, badges: badges }, null, 2));
} else {
  console.log("--- 8gent Code Badge Stats ---");
  console.log(`  Version:    v${version}`);
  console.log(`  Packages:   ${packages}`);
  console.log(`  Benchmarks: ${benchmarks} categories`);
  console.log(`  Tools:      ${tools}`);
  console.log(`  Skills:     ${skills}`);
  console.log(`  License:    ${license}`);
  console.log("");
  console.log("--- Markdown Badge Row (paste into README) ---");
  console.log("");
  console.log(badgeRow);
  console.log("");
}
