/**
 * 8gent Code - CLI Non-Interactive Mode
 *
 * Enables 8gent as a subagent callable from scripts, CI, or other agents.
 *
 * Usage:
 *   8gent --cli "write a rate limiter in under 100 lines"
 *   8gent --cli --output /tmp/result.ts "write a debounce utility"
 *   8gent --cli --json "explain this codebase"
 *   echo "Summarize this" | 8gent --cli
 */

import * as fs from "fs";
import * as path from "path";
import { getProviderManager, type ProviderName } from "../providers/index.ts";

// ============================================
// Types
// ============================================

export interface CLIOptions {
  prompt: string;
  outputPath?: string;
  jsonMode: boolean;
  model?: string;
  provider?: ProviderName;
}

export interface CLIResult {
  response: string;
  files_created: string[];
  files_modified: string[];
  model: string;
  provider: string;
  exitCode: number;
}

// ============================================
// Arg Parsing
// ============================================

export function parseCLIArgs(args: string[]): CLIOptions | null {
  if (!args.includes("--cli")) return null;

  const filtered = args.filter((a) => a !== "--cli");
  const opts: CLIOptions = {
    prompt: "",
    jsonMode: filtered.includes("--json"),
  };

  const withoutFlags: string[] = [];
  for (let i = 0; i < filtered.length; i++) {
    const arg = filtered[i];
    if (arg === "--json") continue;
    if (arg === "--output" || arg === "-o") {
      opts.outputPath = filtered[++i];
    } else if (arg.startsWith("--output=")) {
      opts.outputPath = arg.slice("--output=".length);
    } else if (arg === "--model" || arg === "-m") {
      opts.model = filtered[++i];
    } else if (arg.startsWith("--model=")) {
      opts.model = arg.slice("--model=".length);
    } else if (arg === "--provider") {
      opts.provider = filtered[++i] as ProviderName;
    } else if (arg.startsWith("--provider=")) {
      opts.provider = arg.slice("--provider=".length) as ProviderName;
    } else if (!arg.startsWith("--")) {
      withoutFlags.push(arg);
    }
  }

  opts.prompt = withoutFlags.join(" ").trim();
  return opts;
}

// ============================================
// Stdin Reader
// ============================================

async function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve("");
      return;
    }
    const chunks: Buffer[] = [];
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8").trim()));
    process.stdin.on("error", () => resolve(""));
  });
}

// ============================================
// Code Extractor
// ============================================

function extractCode(text: string): string | null {
  const fenced = text.match(/```(?:typescript|ts|javascript|js)?\n([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();
  // Fall back: if response looks like raw code, return as-is
  if (text.trim().startsWith("//") || text.trim().startsWith("export") || text.trim().startsWith("import")) {
    return text.trim();
  }
  return null;
}

// ============================================
// Track files written during session
// ============================================

const filesCreated: string[] = [];
const filesModified: string[] = [];

function writeOutput(filePath: string, content: string): void {
  const existed = fs.existsSync(filePath);
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, content, "utf-8");
  if (existed) {
    filesModified.push(filePath);
  } else {
    filesCreated.push(filePath);
  }
}

// ============================================
// Main CLI Handler
// ============================================

export async function runCLI(args: string[]): Promise<void> {
  const opts = parseCLIArgs(args);
  if (!opts) {
    console.error("Error: --cli flag required");
    process.exit(1);
  }

  // Read from stdin if no inline prompt
  if (!opts.prompt) {
    opts.prompt = await readStdin();
  }

  if (!opts.prompt) {
    const err = "Error: No prompt provided. Pass a prompt argument or pipe via stdin.";
    if (opts.jsonMode) {
      console.log(JSON.stringify({ error: err, exitCode: 1 }));
    } else {
      console.error(err);
    }
    process.exit(1);
  }

  const manager = getProviderManager();

  if (opts.provider) {
    try {
      manager.setActiveProvider(opts.provider);
    } catch {
      // ignore unknown provider - use default
    }
  }

  try {
    const result = await manager.chat({
      messages: [
        {
          role: "system",
          content:
            "You are 8gent Code, an autonomous coding agent. When asked to write code, output clean TypeScript inside a fenced code block. Be concise and practical.",
        },
        { role: "user", content: opts.prompt },
      ],
      model: opts.model,
    });

    const responseText = result.content;

    if (opts.outputPath) {
      const code = extractCode(responseText) ?? responseText;
      writeOutput(opts.outputPath, code);
    }

    const cliResult: CLIResult = {
      response: responseText,
      files_created: filesCreated,
      files_modified: filesModified,
      model: result.model,
      provider: result.provider,
      exitCode: 0,
    };

    if (opts.jsonMode) {
      console.log(JSON.stringify(cliResult, null, 2));
    } else {
      console.log(responseText);
      if (opts.outputPath) {
        console.error(`Written to: ${opts.outputPath}`);
      }
    }

    process.exit(0);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (opts.jsonMode) {
      console.log(JSON.stringify({ error: message, exitCode: 1 }));
    } else {
      console.error(`Error: ${message}`);
    }
    process.exit(1);
  }
}
