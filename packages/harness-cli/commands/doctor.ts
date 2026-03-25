/**
 * harness-cli: doctor command
 *
 * Health-check: verifies providers are available and tools are loadable.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const SESSIONS_DIR = path.join(os.homedir(), ".8gent", "sessions");

export async function doctor(
  _args: string[],
  options?: { title?: string }
): Promise<boolean> {
  const title = options?.title ?? "8gent Harness — Health Check";
  console.log(`\n  ${title}\n`);

  const checks: Array<{ name: string; pass: boolean; detail: string }> = [];

  // 1. Sessions directory
  const sessionsExist = fs.existsSync(SESSIONS_DIR);
  checks.push({
    name: "Sessions directory",
    pass: sessionsExist,
    detail: sessionsExist ? SESSIONS_DIR : `${SESSIONS_DIR} does not exist`,
  });

  // 2. Session count
  if (sessionsExist) {
    const count = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith(".jsonl")).length;
    checks.push({
      name: "Existing sessions",
      pass: true,
      detail: `${count} session file(s)`,
    });
  }

  // 3. Check Ollama
  try {
    const resp = await fetch("http://localhost:11434/api/tags", { signal: AbortSignal.timeout(3000) });
    if (resp.ok) {
      const data = await resp.json() as any;
      const models = (data.models ?? []).map((m: any) => m.name).slice(0, 5);
      checks.push({
        name: "Ollama",
        pass: true,
        detail: `Running, models: ${models.join(", ") || "none"}`,
      });
    } else {
      checks.push({ name: "Ollama", pass: false, detail: `HTTP ${resp.status}` });
    }
  } catch {
    checks.push({ name: "Ollama", pass: false, detail: "Not running (localhost:11434)" });
  }

  // 4. Check LM Studio
  try {
    const resp = await fetch("http://localhost:1234/v1/models", { signal: AbortSignal.timeout(3000) });
    if (resp.ok) {
      checks.push({ name: "LM Studio", pass: true, detail: "Running on :1234" });
    } else {
      checks.push({ name: "LM Studio", pass: false, detail: `HTTP ${resp.status}` });
    }
  } catch {
    checks.push({ name: "LM Studio", pass: false, detail: "Not running (localhost:1234)" });
  }

  // 5. OpenRouter API key
  const orKey = process.env.OPENROUTER_API_KEY;
  checks.push({
    name: "OpenRouter API key",
    pass: !!orKey,
    detail: orKey ? `Set (${orKey.slice(0, 8)}...)` : "Not set (OPENROUTER_API_KEY)",
  });

  // 6. Agent module loadable
  try {
    const { Agent } = await import("../../eight/agent.js");
    checks.push({ name: "Agent module", pass: true, detail: "packages/eight/agent.ts loaded" });
  } catch (err) {
    checks.push({
      name: "Agent module",
      pass: false,
      detail: `Failed to import: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  // 7. AI SDK tools loadable
  try {
    const { agentTools } = await import("../../ai/tools.js");
    const toolCount = Object.keys(agentTools).length;
    checks.push({ name: "AI SDK tools", pass: true, detail: `${toolCount} tools registered` });
  } catch (err) {
    checks.push({
      name: "AI SDK tools",
      pass: false,
      detail: `Failed to import: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  // Print results
  let allPass = true;
  for (const check of checks) {
    const icon = check.pass ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
    console.log(`  ${icon} ${check.name.padEnd(22)} ${check.detail}`);
    if (!check.pass) allPass = false;
  }

  const ollamaPass = checks.find(c => c.name === "Ollama")?.pass ?? false;
  const lmPass = checks.find(c => c.name === "LM Studio")?.pass ?? false;
  const orPass = checks.find(c => c.name === "OpenRouter API key")?.pass ?? false;
  const hasProvider = ollamaPass || lmPass || orPass;
  const agentPass = checks.find(c => c.name === "Agent module")?.pass ?? false;
  const toolsPass = checks.find(c => c.name === "AI SDK tools")?.pass ?? false;
  /** Enough to run locally: one LLM path + agent stack */
  const workable = hasProvider && agentPass && toolsPass;

  console.log();
  if (allPass) {
    console.log("  \x1b[32mAll checks passed.\x1b[0m\n");
  } else if (workable) {
    console.log(
      "  \x1b[32mCore OK\x1b[0m (Ollama, LM Studio, or OpenRouter). Other lines are optional.\n",
    );
  } else {
    console.log("  \x1b[33mSome checks failed — start Ollama or set OPENROUTER_API_KEY.\x1b[0m\n");
  }

  return workable;
}
