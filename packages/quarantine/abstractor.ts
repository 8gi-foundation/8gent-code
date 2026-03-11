/**
 * 8gent Code - Skill Abstractor
 *
 * Converts external skills to 8gent's conventions.
 * Extracts essential information, discards noise, creates minimal token footprint.
 *
 * Philosophy:
 * - Extract intent, not implementation
 * - Keep only what's needed for the toolshed
 * - Generate 8gent-native skill format
 */

import * as fs from "fs";
import * as path from "path";

// ============================================================================
// Types
// ============================================================================

export interface AbstractedSkill {
  name: string;
  description: string;
  instructions: string;
  tools: string[];
  triggers: string[];
  capabilities: string[];
  examples: string[];
  tokenEstimate: number;
  originalSource: string;
  abstractionTimestamp: string;
}

interface RawSkillData {
  frontmatter: Record<string, unknown>;
  content: string;
  files: string[];
}

// ============================================================================
// Frontmatter Parser
// ============================================================================

function parseFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);

  if (!match) {
    return { frontmatter: {}, body: content };
  }

  const frontmatterText = match[1];
  const body = match[2];
  const frontmatter: Record<string, unknown> = {};

  for (const line of frontmatterText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const colonIndex = trimmed.indexOf(":");
    if (colonIndex === -1) continue;

    const key = trimmed.slice(0, colonIndex).trim();
    let value = trimmed.slice(colonIndex + 1).trim();

    // Parse arrays
    if (value.startsWith("[") && value.endsWith("]")) {
      frontmatter[key] = value.slice(1, -1)
        .split(",")
        .map(item => item.trim().replace(/^['"]|['"]$/g, ""))
        .filter(Boolean);
    } else {
      // Remove quotes
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      frontmatter[key] = value;
    }
  }

  return { frontmatter, body };
}

// ============================================================================
// Content Extractors
// ============================================================================

function extractDescription(content: string, frontmatter: Record<string, unknown>): string {
  // Try frontmatter first
  if (frontmatter.description && typeof frontmatter.description === "string") {
    return frontmatter.description.slice(0, 200);
  }

  // Look for description-like patterns in content
  const descPatterns = [
    /(?:^|\n)#\s*(?:Description|About|Overview)\s*\n+([^\n#]+)/i,
    /(?:^|\n)>\s*([^\n]+)/,  // Blockquote
    /(?:^|\n)([A-Z][^.\n]{20,100}\.)/,  // First sentence
  ];

  for (const pattern of descPatterns) {
    const match = content.match(pattern);
    if (match && match[1]) {
      return match[1].trim().slice(0, 200);
    }
  }

  return "External skill (no description available)";
}

function extractInstructions(content: string): string {
  // Look for instruction sections
  const instructionPatterns = [
    /(?:^|\n)##?\s*(?:Instructions?|Steps?|Usage|How to use)\s*\n+([\s\S]*?)(?=\n##?\s|\n---|\$)/i,
    /(?:^|\n)(?:\d+\.|\-|\*)\s+(.+(?:\n(?:\d+\.|\-|\*)\s+.+)*)/,
  ];

  for (const pattern of instructionPatterns) {
    const match = content.match(pattern);
    if (match && match[1]) {
      return match[1].trim().slice(0, 1000);
    }
  }

  // Fall back to first substantial paragraph
  const paragraphs = content.split(/\n\n+/);
  for (const para of paragraphs) {
    const cleaned = para.replace(/^#+\s*.+\n/, "").trim();
    if (cleaned.length > 50 && !cleaned.startsWith("```")) {
      return cleaned.slice(0, 500);
    }
  }

  return "Follow the skill's guidelines.";
}

function extractTools(content: string, frontmatter: Record<string, unknown>): string[] {
  const tools = new Set<string>();

  // From frontmatter
  if (Array.isArray(frontmatter.tools)) {
    frontmatter.tools.forEach(t => tools.add(String(t)));
  }
  if (Array.isArray(frontmatter["allowed-tools"])) {
    frontmatter["allowed-tools"].forEach(t => tools.add(String(t).replace(/\(\*?\)/, "")));
  }

  // From content - look for tool references
  const toolPatterns = [
    /`(git|npm|bun|yarn|pnpm|docker|kubectl|aws|gcloud|az|terraform)\b/g,
    /\b(Bash|Read|Write|Edit|Glob|Grep|WebFetch|WebSearch)\b/g,
    /\bmcp__(\w+)__/g,
  ];

  for (const pattern of toolPatterns) {
    let match;
    while ((match = pattern.exec(content)) !== null) {
      tools.add(match[1] || match[0]);
    }
  }

  return Array.from(tools).slice(0, 10);
}

function extractTriggers(content: string, frontmatter: Record<string, unknown>, name: string): string[] {
  const triggers = new Set<string>();

  // From frontmatter
  if (Array.isArray(frontmatter.triggers)) {
    frontmatter.triggers.forEach(t => triggers.add(String(t).toLowerCase()));
  }

  // From name
  triggers.add(name.toLowerCase().replace(/[-_]/g, " "));
  triggers.add(name.toLowerCase().replace(/[-_\s]/g, ""));

  // Common trigger words from content
  const triggerPatterns = [
    /\bwhen\s+(?:user\s+)?(?:asks?|wants?|needs?)\s+(?:to\s+)?(\w+(?:\s+\w+)?)/gi,
    /\btrigger(?:s|ed)?\s+(?:by|on|when)\s+["']?(\w+)/gi,
  ];

  for (const pattern of triggerPatterns) {
    let match;
    while ((match = pattern.exec(content)) !== null) {
      if (match[1] && match[1].length < 30) {
        triggers.add(match[1].toLowerCase());
      }
    }
  }

  return Array.from(triggers).slice(0, 8);
}

function extractCapabilities(content: string, frontmatter: Record<string, unknown>): string[] {
  const capabilities = new Set<string>();

  // From frontmatter
  if (Array.isArray(frontmatter.capabilities)) {
    frontmatter.capabilities.forEach(c => capabilities.add(String(c)));
  }

  // Infer from common patterns
  const capPatterns = [
    { pattern: /\bgit\b/i, cap: "version_control" },
    { pattern: /\btest(?:ing|s)?\b/i, cap: "testing" },
    { pattern: /\bdeploy/i, cap: "deployment" },
    { pattern: /\bbuild\b/i, cap: "building" },
    { pattern: /\bapi\b/i, cap: "api_integration" },
    { pattern: /\bdatabase|sql|query\b/i, cap: "database" },
    { pattern: /\bauth(?:entication)?\b/i, cap: "authentication" },
    { pattern: /\bui|interface|component/i, cap: "ui_development" },
    { pattern: /\bdocument|docs?|readme/i, cap: "documentation" },
    { pattern: /\bsearch|find|grep/i, cap: "code_search" },
    { pattern: /\brefactor/i, cap: "refactoring" },
    { pattern: /\banalyze|analysis/i, cap: "code_analysis" },
  ];

  for (const { pattern, cap } of capPatterns) {
    if (pattern.test(content)) {
      capabilities.add(cap);
    }
  }

  return Array.from(capabilities).slice(0, 6);
}

function extractExamples(content: string): string[] {
  const examples: string[] = [];

  // Look for example sections
  const examplePattern = /(?:^|\n)(?:##?\s*)?(?:Example|Usage)s?\s*(?:\d+)?:?\s*\n*```[\s\S]*?```/gi;
  const matches = content.matchAll(examplePattern);

  for (const match of matches) {
    if (examples.length < 3) {
      // Extract just the example description
      const desc = match[0].replace(/```[\s\S]*?```/g, "").trim();
      if (desc.length > 10) {
        examples.push(desc.slice(0, 100));
      }
    }
  }

  // Also look for User: patterns (common in skill docs)
  const userPattern = /User:\s*["']?([^"'\n]+)/gi;
  let userMatch;
  while ((userMatch = userPattern.exec(content)) !== null && examples.length < 3) {
    examples.push(userMatch[1].trim().slice(0, 100));
  }

  return examples;
}

function estimateTokens(text: string): number {
  // Rough estimate: ~4 chars per token
  return Math.ceil(text.length / 4);
}

// ============================================================================
// Main Abstractor
// ============================================================================

export async function abstractSkill(skillDir: string, skillName: string): Promise<AbstractedSkill> {
  const sourceDir = path.join(skillDir, "source");
  const actualDir = fs.existsSync(sourceDir) ? sourceDir : skillDir;

  // Find main skill file
  const mainFiles = ["SKILL.md", "README.md", "skill.md", "readme.md", "index.md"];
  let mainFile: string | null = null;

  for (const file of mainFiles) {
    const filePath = path.join(actualDir, file);
    if (fs.existsSync(filePath)) {
      mainFile = filePath;
      break;
    }
  }

  // Gather all markdown content
  let combinedContent = "";
  const files: string[] = [];

  function walkDir(dir: string) {
    if (!fs.existsSync(dir)) return;

    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;

      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        walkDir(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        files.push(fullPath);
        combinedContent += fs.readFileSync(fullPath, "utf-8") + "\n\n";
      }
    }
  }

  walkDir(actualDir);

  // Parse main file's frontmatter
  const mainContent = mainFile ? fs.readFileSync(mainFile, "utf-8") : combinedContent;
  const { frontmatter, body } = parseFrontmatter(mainContent);

  // Extract and abstract
  const name = (frontmatter.name as string) || skillName;
  const description = extractDescription(combinedContent, frontmatter);
  const instructions = extractInstructions(combinedContent);
  const tools = extractTools(combinedContent, frontmatter);
  const triggers = extractTriggers(combinedContent, frontmatter, name);
  const capabilities = extractCapabilities(combinedContent, frontmatter);
  const examples = extractExamples(combinedContent);

  const abstracted: AbstractedSkill = {
    name,
    description,
    instructions,
    tools,
    triggers,
    capabilities,
    examples,
    tokenEstimate: estimateTokens(description + instructions),
    originalSource: skillDir,
    abstractionTimestamp: new Date().toISOString(),
  };

  return abstracted;
}

// ============================================================================
// Toolshed Registration Format
// ============================================================================

/**
 * Generate minimal toolshed entry for token efficiency
 */
export function toToolshedEntry(skill: AbstractedSkill): string {
  return `- ${skill.name}: ${skill.description.slice(0, 80)}`;
}

/**
 * Generate detailed but still compact format
 */
export function toDetailedEntry(skill: AbstractedSkill): object {
  return {
    name: skill.name,
    description: skill.description,
    capabilities: skill.capabilities,
    triggers: skill.triggers,
    tokens: skill.tokenEstimate,
  };
}
