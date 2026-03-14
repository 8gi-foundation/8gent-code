/**
 * harness-cli: run command
 *
 * Runs a headless 8gent session and captures the full result.
 * Outputs session ID + summary so callers can inspect or validate.
 *
 * SAFETY: Always creates an isolated temp directory unless --workdir
 * is explicitly given. Refuses to run inside a git repo to prevent
 * accidental overwrites of real project files.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { Agent } from "../../eight/agent.js";
import type { AgentConfig } from "../../eight/types.js";
import { getPermissionManager } from "../../permissions/index.js";

interface RunOptions {
  prompt: string;
  model: string;
  runtime: "ollama" | "lmstudio" | "openrouter";
  maxSteps: number;
  workdir: string | null;
  timeout: number;
  json: boolean;
  apiKey?: string;
  task: string;
}

/** Built-in task presets */
const TASK_PRESETS: Record<string, { prompt: string; validate: string }> = {
  fib: {
    prompt:
      "Create a file called fib.js that computes and prints the first 20 Fibonacci numbers. Use write_file to create fib.js, then run it with node fib.js to verify it works.",
    validate: "fib.js",
  },
  nextjs: {
    prompt:
      "Build a Next.js project in the current directory. Steps: 1) Create package.json with next, react, react-dom dependencies 2) Create app/layout.tsx with basic HTML layout 3) Create app/page.tsx that displays a heading saying Hello World 4) Create next.config.js 5) Create tsconfig.json 6) Run bun install to install dependencies 7) Run npx next build to verify it compiles",
    validate: "package.json",
  },
  api: {
    prompt:
      "Build a REST API with integration tests using Hono and Bun. Steps: 1) Create package.json with hono as a dependency 2) Run bun install 3) Create server.ts with a Hono app that has CRUD routes for todos: GET /todos, POST /todos, PUT /todos/:id, DELETE /todos/:id. Store todos in-memory. Each todo has id (number), title (string), completed (boolean). The server must listen on port 3456. 4) Create api.test.ts using bun:test that tests all 4 endpoints. The test file should start the server as a subprocess, wait for it to be ready, run fetch requests against http://localhost:3456, then kill the server. Tests: create a todo, list and verify it exists, update it, delete it, verify deletion. 5) Run bun test. If tests fail, read the error, fix the code, and re-run until ALL tests pass. Do NOT keep retrying the same approach — if something fails 3 times, try a completely different strategy.",
    validate: "server.ts",
  },
  fullstack: {
    prompt: `Build a full-stack task management app with Bun. This has 6 files that must all work together:

1) db.ts — An in-memory database class with methods: addTask(title) returns {id, title, done, createdAt}, getAll() returns Task[], getById(id), updateTask(id, updates), deleteTask(id), getStats() returns {total, done, pending}. Use a Map internally. Auto-increment IDs starting at 1.

2) validation.ts — Export functions: validateTitle(title) throws if empty/over 100 chars, validateId(id) throws if not a positive integer, validateUpdates(updates) throws if unknown fields. Each throws a ValidationError class you define with a code property.

3) server.ts — Hono REST API on port 4567 that uses db.ts and validation.ts:
   GET /tasks — list all tasks
   GET /tasks/:id — get one task (404 if missing)
   POST /tasks — create task (validates title, returns 201)
   PATCH /tasks/:id — update task (validates updates, 404 if missing)
   DELETE /tasks/:id — delete task (404 if missing)
   GET /stats — return db.getStats()
   All errors return proper JSON {error, code} with correct HTTP status codes.

4) db.test.ts — 10 tests for the database class covering add, get, update, delete, getStats, and edge cases like getting a non-existent ID.

5) validation.test.ts — 8 tests for all validation functions covering valid inputs, empty strings, too-long strings, invalid IDs, unknown fields.

6) api.test.ts — 12 integration tests that start the server as a subprocess and test the full HTTP API including error responses (404, 400), correct status codes, and the stats endpoint.

Steps: Create all 6 files. Run bun test. If ANY test fails, read the error carefully, fix the specific issue, and re-run. ALL 30 tests must pass. Do not retry the same fix — if something fails 3 times, try a different approach entirely.`,
    validate: "server.ts",
  },
  "nextjs-e2e": {
    prompt: `Complete these tasks in order:
1) Create a new Next.js project using bun create next-app
2) Start the dev server using bun run dev (from inside the project directory)
3) Change the homepage (app/page.tsx or src/app/page.tsx) to display only: <h1>Hello James</h1>
4) Verify the file was written correctly by reading it back
5) Report the dev server URL and confirm the homepage was changed`,
    validate: "page.tsx",
  },
};

function parseArgs(args: string[]): RunOptions {
  const opts: RunOptions = {
    prompt: "",
    model: process.env.EIGHGENT_MODEL || "openai/gpt-4.1-mini",
    runtime: (process.env.EIGHGENT_RUNTIME as RunOptions["runtime"]) || "openrouter",
    maxSteps: 30,
    workdir: null, // null = auto-create temp dir
    timeout: 300_000,
    json: false,
    apiKey: process.env.OPENROUTER_API_KEY,
    task: "",
  };

  const promptParts: string[] = [];
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    switch (arg) {
      case "--model":
        opts.model = args[++i];
        break;
      case "--runtime":
        opts.runtime = args[++i] as RunOptions["runtime"];
        break;
      case "--max-steps":
        opts.maxSteps = parseInt(args[++i], 10);
        break;
      case "--workdir":
        opts.workdir = args[++i];
        break;
      case "--timeout":
        opts.timeout = parseInt(args[++i], 10);
        break;
      case "--json":
        opts.json = true;
        break;
      case "--api-key":
        opts.apiKey = args[++i];
        break;
      case "--task":
        opts.task = args[++i];
        break;
      default:
        promptParts.push(arg);
    }
    i++;
  }

  // Apply task preset if specified
  if (opts.task && TASK_PRESETS[opts.task]) {
    opts.prompt = TASK_PRESETS[opts.task].prompt;
  } else if (promptParts.length > 0) {
    opts.prompt = promptParts.join(" ");
  }

  return opts;
}

/** Check if a directory is inside a git repo */
function isInsideGitRepo(dir: string): boolean {
  let current = path.resolve(dir);
  while (current !== path.dirname(current)) {
    if (fs.existsSync(path.join(current, ".git"))) return true;
    current = path.dirname(current);
  }
  return false;
}

/** Create an isolated temp directory for the run */
function createTempWorkdir(label: string): string {
  const slug = label.replace(/[^a-z0-9]/gi, "-").slice(0, 30).toLowerCase();
  const dir = path.join(os.tmpdir(), `8gent-test-${slug}-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export async function run(args: string[]): Promise<void> {
  const opts = parseArgs(args);

  if (!opts.prompt) {
    console.error("Usage: bun run harness run <prompt> [options]");
    console.error("       bun run harness run --task fib");
    console.error("       bun run harness run --task nextjs");
    console.error("");
    console.error("Task presets: fib, nextjs");
    console.error("Or provide a custom prompt as positional args.");
    process.exit(1);
  }

  // Resolve working directory
  let workdir: string;
  let autoCreated = false;

  if (opts.workdir) {
    workdir = path.resolve(opts.workdir);
    // Safety: refuse to run inside a git repo unless it's under /tmp
    if (isInsideGitRepo(workdir) && !workdir.startsWith(os.tmpdir()) && !workdir.startsWith("/tmp")) {
      console.error(`[SAFETY] Refusing to run inside a git repo: ${workdir}`);
      console.error(`         8gent writes files — this would overwrite your project.`);
      console.error(`         Use --workdir /tmp/something or omit --workdir for auto temp dir.`);
      process.exit(1);
    }
    if (!fs.existsSync(workdir)) {
      fs.mkdirSync(workdir, { recursive: true });
    }
  } else {
    // Auto-create isolated temp dir
    workdir = createTempWorkdir(opts.task || "run");
    autoCreated = true;
  }

  // Enable infinite mode — headless runs bypass permission prompts
  const permManager = getPermissionManager();
  permManager.enableInfiniteMode();

  const config: AgentConfig = {
    model: opts.model,
    runtime: opts.runtime,
    workingDirectory: workdir,
    maxTurns: opts.maxSteps,
    apiKey: opts.apiKey,
  };

  const agent = new Agent(config);

  // Check provider health
  if (!(await agent.isReady())) {
    const msg = `Provider "${opts.runtime}" is not available. Is ${opts.runtime} running?`;
    if (opts.json) {
      console.log(JSON.stringify({ error: msg, success: false }));
    } else {
      console.error(`[ERROR] ${msg}`);
    }
    process.exit(1);
  }

  const sessionPath = agent.getSessionFilePath();
  const sessionId = sessionPath.split("/").pop()?.replace(".jsonl", "") ?? "unknown";

  if (!opts.json) {
    console.log(`[harness] Session: ${sessionId}`);
    console.log(`[harness] Model: ${opts.model} (${opts.runtime})`);
    console.log(`[harness] Working dir: ${workdir}${autoCreated ? " (auto-created)" : ""}`);
    console.log(`[harness] Max steps: ${opts.maxSteps}`);
    console.log(`[harness] Prompt: ${opts.prompt.slice(0, 120)}${opts.prompt.length > 120 ? "..." : ""}`);
    console.log(`[harness] Session file: ${sessionPath}`);
    console.log(`[harness] ─────────────────────────────────`);
  }

  const startTime = Date.now();

  // Run with timeout
  let result: string;
  let success = true;
  let error: string | null = null;

  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`Timeout after ${opts.timeout}ms`)), opts.timeout);
    });

    result = await Promise.race([
      agent.chat(opts.prompt),
      timeoutPromise,
    ]);
  } catch (err) {
    success = false;
    error = err instanceof Error ? err.message : String(err);
    result = "";
  }

  const durationMs = Date.now() - startTime;

  // Cleanup
  try {
    await agent.cleanup();
  } catch {
    // already closed
  }

  if (opts.json) {
    console.log(JSON.stringify({
      success,
      sessionId,
      sessionPath,
      workdir,
      model: opts.model,
      runtime: opts.runtime,
      prompt: opts.prompt,
      result: result.slice(0, 5000),
      error,
      durationMs,
    }, null, 2));
  } else {
    console.log(`[harness] ─────────────────────────────────`);
    if (success) {
      console.log(`[harness] SUCCESS in ${(durationMs / 1000).toFixed(1)}s`);
      console.log(`[harness] Result (first 2000 chars):`);
      console.log(result.slice(0, 2000));
    } else {
      console.log(`[harness] FAILED in ${(durationMs / 1000).toFixed(1)}s`);
      console.log(`[harness] Error: ${error}`);
    }
    console.log(`\n[harness] Session ID: ${sessionId}`);
    console.log(`[harness] Working dir: ${workdir}`);
    console.log(`[harness] Inspect: bun run harness inspect ${sessionId}`);
    console.log(`[harness] Check output: ls ${workdir}`);
  }
}
