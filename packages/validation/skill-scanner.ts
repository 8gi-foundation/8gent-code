/**
 * Skill Scanner - validates all installed Claude Code skills
 *
 * Scans ~/.claude/skills/ for SKILL.md files, validates frontmatter,
 * checks for broken file references, and outputs a skills inventory.
 */

import { readdir, readFile, access } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { homedir } from "node:os";

// --- Types ---

interface SkillReport {
  name: string;
  description: string;
  path: string;
  valid: boolean;
  errors: string[];
  triggers: string[];
  referencedFiles: { path: string; exists: boolean }[];
}

interface ScanResult {
  total: number;
  valid: number;
  invalid: number;
  skills: SkillReport[];
  dirsWithoutSkillMd: string[];
}

// --- Frontmatter parsing ---

function parseFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const fields: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx > 0) {
      fields[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
  }
  return fields;
}

// --- Trigger extraction ---

function extractTriggers(content: string): string[] {
  const triggers: string[] = [];
  // "USE WHEN" pattern in description or body
  const useWhen = content.match(/USE WHEN[:\s]+([^\n.]+)/i);
  if (useWhen) triggers.push(useWhen[1].trim());
  // Workflow trigger table rows: | **Name** | "trigger phrase" | file |
  for (const m of content.matchAll(/\|\s*\*\*(\w+)\*\*\s*\|\s*"([^"]+)"/g)) {
    triggers.push(`${m[1]}: ${m[2]}`);
  }
  // Slash command triggers
  for (const m of content.matchAll(/\/(\w[\w-]+)/g)) {
    if (!["dev", "src", "etc", "bin", "tmp"].includes(m[1])) {
      triggers.push(`/${m[1]}`);
    }
  }
  return [...new Set(triggers)];
}

// --- File reference checking ---

function extractFileRefs(content: string, baseDir: string): string[] {
  const refs: string[] = [];
  // Markdown links to local files
  for (const m of content.matchAll(/\[.*?\]\(([^)]+)\)/g)) {
    const ref = m[1];
    if (!ref.startsWith("http") && !ref.startsWith("#")) {
      refs.push(resolve(baseDir, ref));
    }
  }
  // @file references
  for (const m of content.matchAll(/@([^\s]+\.(?:md|ts|json|yaml|yml))/g)) {
    refs.push(resolve(baseDir, m[1]));
  }
  return [...new Set(refs)];
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

// --- Main scanner ---

export async function scanSkills(
  skillsDir = join(homedir(), ".claude", "skills")
): Promise<ScanResult> {
  const entries = await readdir(skillsDir, { withFileTypes: true });
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);

  const skills: SkillReport[] = [];
  const dirsWithoutSkillMd: string[] = [];

  for (const dir of dirs) {
    const skillPath = join(skillsDir, dir, "SKILL.md");
    const exists = await fileExists(skillPath);

    if (!exists) {
      dirsWithoutSkillMd.push(dir);
      continue;
    }

    const content = await readFile(skillPath, "utf-8");
    const frontmatter = parseFrontmatter(content);
    const errors: string[] = [];

    if (!frontmatter.name) errors.push("missing frontmatter: name");
    if (!frontmatter.description) errors.push("missing frontmatter: description");

    const baseDir = dirname(skillPath);
    const fileRefs = extractFileRefs(content, baseDir);
    const referencedFiles = await Promise.all(
      fileRefs.map(async (p) => ({ path: p, exists: await fileExists(p) }))
    );

    const broken = referencedFiles.filter((r) => !r.exists);
    for (const b of broken) {
      errors.push(`broken ref: ${b.path}`);
    }

    skills.push({
      name: frontmatter.name || dir,
      description: frontmatter.description || "(none)",
      path: skillPath,
      valid: errors.length === 0,
      errors,
      triggers: extractTriggers(content),
      referencedFiles,
    });
  }

  const valid = skills.filter((s) => s.valid).length;

  return {
    total: skills.length,
    valid,
    invalid: skills.length - valid,
    skills,
    dirsWithoutSkillMd,
  };
}

// --- CLI entry point ---

if (import.meta.main) {
  const result = await scanSkills();

  console.log(`\n=== Skill Scanner Report ===\n`);
  console.log(`Total skills scanned: ${result.total}`);
  console.log(`Valid: ${result.valid} | Invalid: ${result.invalid}`);

  if (result.dirsWithoutSkillMd.length > 0) {
    console.log(`\nDirs without SKILL.md (${result.dirsWithoutSkillMd.length}):`);
    for (const d of result.dirsWithoutSkillMd) console.log(`  - ${d}`);
  }

  if (result.invalid > 0) {
    console.log(`\n--- Invalid Skills ---`);
    for (const s of result.skills.filter((s) => !s.valid)) {
      console.log(`\n  ${s.name} (${s.path})`);
      for (const e of s.errors) console.log(`    [!] ${e}`);
    }
  }

  console.log(`\n--- Skills Inventory ---`);
  for (const s of result.skills) {
    const status = s.valid ? "OK" : "INVALID";
    console.log(`\n  [${status}] ${s.name}`);
    console.log(`    ${s.description}`);
    if (s.triggers.length > 0) {
      console.log(`    Triggers: ${s.triggers.join("; ")}`);
    }
  }

  console.log("");
  process.exit(result.invalid > 0 ? 1 : 0);
}
