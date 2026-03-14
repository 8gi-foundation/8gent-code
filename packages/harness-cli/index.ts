#!/usr/bin/env bun
/**
 * 8gent Harness CLI
 *
 * Headless CLI for running, inspecting, and testing 8gent agent sessions.
 * Designed for automated testing and feedback loops — no TUI required.
 *
 * SAFETY: The `run` command auto-creates an isolated temp directory.
 * It will refuse to run inside a git repo to prevent overwrites.
 */

import { run } from "./commands/run.js";
import { sessions } from "./commands/sessions.js";
import { inspect } from "./commands/inspect.js";
import { tail } from "./commands/tail.js";
import { validate } from "./commands/validate.js";
import { doctor } from "./commands/doctor.js";

const HELP = `
8gent Harness CLI — Headless agent testing & inspection

QUICK START:
  bun run harness run --task fib          Fibonacci test (fast, ~7s)
  bun run harness run --task nextjs       Next.js hello world (hard, ~100s)
  bun run harness run "your prompt here"  Custom task

  All runs auto-create an isolated /tmp directory. Safe by default.

COMMANDS:
  run <prompt> [options]     Run a headless agent session
    --task <preset>          Use a preset: fib, nextjs
    --model <model>          Model (default: openai/gpt-4.1-mini)
    --runtime <runtime>      Provider: ollama, lmstudio, openrouter (default: openrouter)
    --max-steps <n>          Max agentic steps (default: 30)
    --workdir <path>         Working directory (default: auto temp dir)
    --timeout <ms>           Abort after N ms (default: 300000 = 5min)
    --json                   Output result as JSON

  sessions [options]         List all sessions
    --limit <n>              Max sessions to show (default: 20)
    --json                   Output as JSON
    --filter <status>        Filter: completed, failed, running

  inspect <session-id>       Show full session entries
    --json                   Output as JSON
    --entries <types>        Filter entry types (comma-separated)
    --summary                Show summary only

  tail <session-id>          Live-tail a running session

  validate <session-id>      Validate session output
    --expect <substring>     Expect output to contain substring
    --expect-file <path>     Expect file to have been created
    --expect-exit <reason>   Expect exit reason

  doctor                     Health-check providers and tools

EXAMPLES:
  bun run harness run --task fib
  bun run harness run --task nextjs --model anthropic/claude-sonnet-4
  bun run harness run "Create a Python script that sorts a list" --runtime ollama
  bun run harness sessions --limit 5
  bun run harness inspect <session-id>
`;

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes("-h") || args.includes("--help")) {
    console.log(HELP);
    process.exit(0);
  }

  const command = args[0];
  const restArgs = args.slice(1);

  try {
    switch (command) {
      case "run":
        await run(restArgs);
        break;
      case "sessions":
        await sessions(restArgs);
        break;
      case "inspect":
        await inspect(restArgs);
        break;
      case "tail":
        await tail(restArgs);
        break;
      case "validate":
        await validate(restArgs);
        break;
      case "doctor":
        await doctor(restArgs);
        break;
      default:
        console.error(`Unknown command: ${command}`);
        console.log("Run with --help for usage.");
        process.exit(1);
    }
  } catch (err) {
    console.error(`\n[FATAL] ${err instanceof Error ? err.message : String(err)}`);
    if (err instanceof Error && err.stack) {
      console.error(err.stack);
    }
    process.exit(1);
  }
}

main();
