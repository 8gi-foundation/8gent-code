/**
 * harness-cli: validate command
 *
 * Validates a session's outcome — did it complete? Did it create the expected
 * files? Does the output contain expected content? Exit code 0 = pass, 1 = fail.
 *
 * This is the key tool for the feedback loop: run 8gent, then validate the result.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as readline from "readline";
import type { SessionEntry } from "../../specifications/session/index.js";

const SESSIONS_DIR = path.join(os.homedir(), ".8gent", "sessions");

interface ValidateOptions {
  sessionId: string;
  expectSubstring: string | null;
  expectFile: string | null;
  expectExit: string | null;
  expectNoErrors: boolean;
  strictArtifacts: boolean;
  json: boolean;
}

function parseArgs(args: string[]): ValidateOptions {
  const opts: ValidateOptions = {
    sessionId: "",
    expectSubstring: null,
    expectFile: null,
    expectExit: null,
    expectNoErrors: false,
    strictArtifacts: false,
    json: false,
  };

  let i = 0;
  while (i < args.length) {
    switch (args[i]) {
      case "--expect":
        opts.expectSubstring = args[++i];
        break;
      case "--expect-file":
        opts.expectFile = args[++i];
        break;
      case "--expect-exit":
        opts.expectExit = args[++i];
        break;
      case "--no-errors":
        opts.expectNoErrors = true;
        break;
      case "--strict":
      case "--strict-artifacts":
        opts.strictArtifacts = true;
        break;
      case "--json":
        opts.json = true;
        break;
      default:
        if (!opts.sessionId) opts.sessionId = args[i];
    }
    i++;
  }
  return opts;
}

function resolveSessionPath(sessionId: string): string {
  if (fs.existsSync(sessionId)) return sessionId;
  const withExt = sessionId.endsWith(".jsonl") ? sessionId : `${sessionId}.jsonl`;
  const fullPath = path.join(SESSIONS_DIR, withExt);
  if (fs.existsSync(fullPath)) return fullPath;
  if (fs.existsSync(SESSIONS_DIR)) {
    const files = fs.readdirSync(SESSIONS_DIR);
    const match = files.find(f => f.startsWith(sessionId));
    if (match) return path.join(SESSIONS_DIR, match);
  }
  throw new Error(`Session not found: ${sessionId}`);
}

async function readEntries(filePath: string): Promise<SessionEntry[]> {
  const entries: SessionEntry[] = [];
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as SessionEntry);
    } catch { /* skip */ }
  }
  return entries;
}

interface ValidationResult {
  pass: boolean;
  checks: Array<{
    name: string;
    pass: boolean;
    message: string;
  }>;
  sessionCompleted: boolean;
  exitReason: string | null;
  errors: string[];
  assistantOutput: string;
  filesCreated: string[];
  totalSteps: number;
  totalTokens: number;
  artifactChecks?: {
    checked: string[];
    missing: string[];
  };
}

function collectArtifactRefs(entries: SessionEntry[], sessionEnd: any): string[] {
  const refs = new Set<string>();

  for (const p of [...(sessionEnd?.summary?.filesCreated ?? []), ...(sessionEnd?.summary?.filesModified ?? [])]) {
    if (typeof p === "string" && p.trim()) refs.add(p.trim());
  }

  for (const e of entries) {
    if (e.type !== "tool_result") continue;
    const raw = (e as any).result;
    if (!raw) continue;

    let obj: Record<string, unknown> | null = null;
    if (typeof raw === "string") {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") obj = parsed as Record<string, unknown>;
      } catch {
        obj = null;
      }
    } else if (typeof raw === "object") {
      obj = raw as Record<string, unknown>;
    }

    if (!obj) continue;
    for (const k of ["path", "file", "output_path", "raw_output_path"]) {
      const v = obj[k];
      if (typeof v === "string" && v.trim()) refs.add(v.trim());
    }
  }

  return [...refs];
}

function pathExistsFlexible(refPath: string, sessionFilePath: string): boolean {
  if (fs.existsSync(refPath)) return true;

  const sessionDir = path.dirname(sessionFilePath);
  const candidates = [
    path.resolve(refPath),
    path.resolve(sessionDir, refPath),
    path.resolve(process.cwd(), refPath),
  ];

  return candidates.some((p) => fs.existsSync(p));
}

export async function validate(args: string[]): Promise<void> {
  const opts = parseArgs(args);

  if (!opts.sessionId) {
    console.error("Usage: harness-cli validate <session-id> [--expect <substr>] [--expect-file <path>] [--strict-artifacts]");
    process.exit(1);
  }

  const filePath = resolveSessionPath(opts.sessionId);
  const entries = await readEntries(filePath);

  // Extract data from entries
  const sessionEnd = entries.find(e => e.type === "session_end") as any;
  const errors: string[] = [];
  let assistantOutput = "";
  const filesCreated: string[] = [];

  for (const e of entries) {
    if (e.type === "error") {
      errors.push((e as any).error?.message ?? "Unknown error");
    }
    if (e.type === "tool_error") {
      errors.push(`${(e as any).toolName}: ${(e as any).error}`);
    }
    if (e.type === "assistant_content") {
      const parts = (e as any).parts ?? [];
      for (const p of parts) {
        if (p.type === "text") assistantOutput += (p.text ?? "") + "\n";
      }
    }
    if (e.type === "assistant_message") {
      assistantOutput += ((e as any).message?.content ?? "") + "\n";
    }
  }

  if (sessionEnd?.summary?.filesCreated) {
    filesCreated.push(...sessionEnd.summary.filesCreated);
  }

  const result: ValidationResult = {
    pass: true,
    checks: [],
    sessionCompleted: !!sessionEnd,
    exitReason: sessionEnd?.summary?.exitReason ?? null,
    errors,
    assistantOutput: assistantOutput.trim(),
    filesCreated,
    totalSteps: sessionEnd?.summary?.totalSteps ?? 0,
    totalTokens: sessionEnd?.summary?.totalTokens ?? 0,
  };

  // Check 1: Session completed
  result.checks.push({
    name: "session_completed",
    pass: !!sessionEnd,
    message: sessionEnd ? `Completed (exit: ${sessionEnd.summary?.exitReason})` : "Session did not complete (no session_end entry)",
  });
  if (!sessionEnd) result.pass = false;

  // Check 2: Expected exit reason
  if (opts.expectExit) {
    const match = sessionEnd?.summary?.exitReason === opts.expectExit;
    result.checks.push({
      name: "exit_reason",
      pass: match,
      message: match
        ? `Exit reason matches: ${opts.expectExit}`
        : `Expected exit "${opts.expectExit}", got "${sessionEnd?.summary?.exitReason ?? "none"}"`,
    });
    if (!match) result.pass = false;
  }

  // Check 3: Expected substring in output
  if (opts.expectSubstring) {
    const found = assistantOutput.toLowerCase().includes(opts.expectSubstring.toLowerCase());
    result.checks.push({
      name: "output_contains",
      pass: found,
      message: found
        ? `Output contains "${opts.expectSubstring}"`
        : `Output does not contain "${opts.expectSubstring}"`,
    });
    if (!found) result.pass = false;
  }

  // Check 4: Expected file created
  if (opts.expectFile) {
    const fileExists = fs.existsSync(opts.expectFile) ||
      fs.existsSync(path.resolve(opts.expectFile));
    result.checks.push({
      name: "file_created",
      pass: fileExists,
      message: fileExists
        ? `File exists: ${opts.expectFile}`
        : `File not found: ${opts.expectFile}`,
    });
    if (!fileExists) result.pass = false;
  }

  // Check 5: No errors
  if (opts.expectNoErrors) {
    const noErrors = errors.length === 0;
    result.checks.push({
      name: "no_errors",
      pass: noErrors,
      message: noErrors
        ? "No errors"
        : `${errors.length} error(s): ${errors[0]?.slice(0, 100)}`,
    });
    if (!noErrors) result.pass = false;
  }

  // Check 6: Strict artifact existence
  if (opts.strictArtifacts) {
    const checked = collectArtifactRefs(entries, sessionEnd);
    const missing = checked.filter((p) => !pathExistsFlexible(p, filePath));
    result.artifactChecks = { checked, missing };

    const pass = missing.length === 0;
    result.checks.push({
      name: "artifacts_exist",
      pass,
      message: pass
        ? `All referenced artifacts exist (${checked.length} checked)`
        : `${missing.length} missing artifact(s): ${missing.slice(0, 3).join(", ")}`,
    });

    if (!pass) result.pass = false;
  }

  // Output
  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const icon = result.pass ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m";
    console.log(`\n  Validation: ${icon}`);
    console.log("  " + "─".repeat(50));

    for (const check of result.checks) {
      const ci = check.pass ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
      console.log(`  ${ci} ${check.name}: ${check.message}`);
    }

    console.log(`\n  Steps: ${result.totalSteps}, Tokens: ${result.totalTokens}, Errors: ${result.errors.length}`);
    if (result.artifactChecks) {
      console.log(`  Artifacts checked: ${result.artifactChecks.checked.length}, missing: ${result.artifactChecks.missing.length}`);
    }

    if (result.assistantOutput) {
      console.log(`\n  Last output (first 500 chars):`);
      console.log(`  ${result.assistantOutput.slice(0, 500)}`);
    }
    console.log();
  }

  process.exit(result.pass ? 0 : 1);
}
