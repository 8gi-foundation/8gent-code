// 8gi:200-exempt — ExtensionCrafter uses HyperAgent pipeline, inherently complex
/**
 * ExtensionCrafter
 * Converts arbitrary source (local path or GitHub URL) into a working 8gent extension.
 * Uses Analyst→Critic→Implementer pipeline from @8gent/orchestration.
 */
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execSync } from "child_process";
import { inferenceChat } from "../orchestration/sequential-pipeline";
import { loadAllExtensions, collectExtensionTools } from "./loader";
import type { ExtensionManifest, ExtensionToolDef } from "./types";

const EXTENSIONS_DIR = path.join(os.homedir(), ".8gent", "extensions");
const DEFAULT_MODEL = process.env.CRAFTER_MODEL || "qwen3:14b";

export interface CraftOptions {
  source: string;
  targetCapability?: string;
  dryRun?: boolean;
  model?: string;
}

export interface CraftResult {
  manifest: ExtensionManifest;
  installed: boolean;
  path: string;
  warnings: string[];
}

export async function craftExtension(opts: CraftOptions): Promise<CraftResult> {
  const warnings: string[] = [];
  const model = opts.model ?? DEFAULT_MODEL;

  const sourceDir = await resolveSource(opts.source, warnings);
  const sourceContext = gatherSourceContext(sourceDir, opts.targetCapability);

  // Pass 1: Analyst
  const analystResult = await inferenceChat(model, ANALYST_PROMPT, sourceContext);
  if (!analystResult.content) throw new Error("ExtensionCrafter: Analyst returned empty");

  // Pass 2: Critic
  const criticResult = await inferenceChat(
    model, CRITIC_PROMPT,
    `SOURCE:\n${sourceContext}\n\nANALYST:\n${analystResult.content}`
  );
  if (criticResult.content.includes("REJECTED")) {
    throw new Error(`ExtensionCrafter: Critic rejected source.\n${criticResult.content}`);
  }

  // Pass 3: Implementer — generate manifest
  const implResult = await inferenceChat(
    model, IMPLEMENTER_PROMPT,
    `ANALYST:\n${analystResult.content}\n\nCRITIC:\n${criticResult.content}\n\nSOURCE:\n${sourceContext}`
  );

  const manifest = parseManifest(implResult.content, sourceDir, warnings);

  if (opts.dryRun) return { manifest, installed: false, path: "", warnings };

  const installPath = install(manifest, sourceDir, warnings);

  // Hot-reload
  await loadAllExtensions();

  return { manifest, installed: true, path: installPath, warnings };
}

async function resolveSource(source: string, warnings: string[]): Promise<string> {
  const expanded = source.replace(/^~/, os.homedir());
  if (fs.existsSync(expanded)) return expanded;

  if (source.startsWith("https://github.com/")) {
    const tmp = path.join(os.tmpdir(), `8gent-craft-${Date.now()}`);
    try {
      execSync(`git clone --depth=1 "${source}" "${tmp}"`, { stdio: "ignore", timeout: 30000 });
      return tmp;
    } catch (err) {
      throw new Error(`ExtensionCrafter: Clone failed: ${err}`);
    }
  }

  throw new Error(`ExtensionCrafter: Source not found: ${source}`);
}

function gatherSourceContext(sourceDir: string, targetCapability?: string): string {
  const parts: string[] = [];
  if (targetCapability) parts.push(`TARGET CAPABILITY: ${targetCapability}\n`);

  for (const name of ["README.md", "readme.md"]) {
    const p = path.join(sourceDir, name);
    if (fs.existsSync(p)) { parts.push(`README:\n${fs.readFileSync(p, "utf-8").slice(0, 2000)}`); break; }
  }

  const pkg = path.join(sourceDir, "package.json");
  if (fs.existsSync(pkg)) parts.push(`package.json:\n${fs.readFileSync(pkg, "utf-8").slice(0, 1000)}`);

  for (const rel of ["index.ts", "index.js", "src/index.ts", "src/index.js"]) {
    const p = path.join(sourceDir, rel);
    if (fs.existsSync(p)) { parts.push(`ENTRY (${rel}):\n${fs.readFileSync(p, "utf-8").slice(0, 3000)}`); break; }
  }

  return parts.join("\n---\n");
}

function parseManifest(response: string, sourceDir: string, warnings: string[]): ExtensionManifest {
  const m = response.match(/```json\n([\s\S]+?)\n```/);
  if (m) {
    try {
      const raw = JSON.parse(m[1]);
      return {
        name: raw.name ?? path.basename(sourceDir).toLowerCase().replace(/[^a-z0-9-]/g, "-"),
        version: raw.version ?? "0.1.0",
        description: raw.description ?? "Auto-crafted extension",
        entry: raw.entry ?? "index.ts",
        permissions: raw.permissions ?? [],
        tools: (raw.tools ?? []) as ExtensionToolDef[],
      };
    } catch { warnings.push("JSON parse failed — using defaults"); }
  }
  warnings.push("Manifest derived from defaults — review before production use");
  return {
    name: path.basename(sourceDir).toLowerCase().replace(/[^a-z0-9-]/g, "-"),
    version: "0.1.0",
    description: `Auto-crafted from ${path.basename(sourceDir)}`,
    entry: "index.ts",
    permissions: [],
    tools: [],
  };
}

function install(manifest: ExtensionManifest, sourceDir: string, warnings: string[]): string {
  const dest = path.join(EXTENSIONS_DIR, manifest.name);
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(path.join(dest, "8gent-extension.json"), JSON.stringify(manifest, null, 2));
  try {
    execSync(`cp -r "${sourceDir}/." "${dest}/"`, { stdio: "ignore" });
  } catch {
    warnings.push("Source copy failed — manifest written, entry needs manual setup");
  }
  return dest;
}

const ANALYST_PROMPT = `You are an Analyst. Review source code and identify what it does and what it exports.
Output format:
CAPABILITY: <one sentence>
EXPORTS: <list of function names>
ENTRY: <relative path to main entry>
SUITABLE: YES or NO
REASON: <why suitable or not>`;

const CRITIC_PROMPT = `You are a Critic. REJECT if: no callable exports, dangerous undeclared operations, or no clear capability.
APPROVE if: has callable exports and clear purpose.
Output: VERDICT: APPROVED or REJECTED\nFLAWS: ...\nPERMISSIONS_NEEDED: ...`;

const IMPLEMENTER_PROMPT = `Generate a valid 8gent-extension.json manifest as a JSON code block.
\`\`\`json
{"name":"kebab-name","version":"0.1.0","description":"...","entry":"index.ts","permissions":[],"tools":[]}
\`\`\``;
