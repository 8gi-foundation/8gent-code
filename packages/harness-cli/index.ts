#!/usr/bin/env bun
/**
 * 8gent Harness CLI
 *
 * Headless CLI for running, inspecting, and testing 8gent agent sessions.
 * Designed for automated testing and feedback loops — no TUI required.
 *
 * Commands:
 *   run <prompt>           Run a headless agent session, output session ID
 *   sessions               List all sessions with summaries
 *   inspect <session-id>   Show full session contents (entries, tools, errors)
 *   tail <session-id>      Live-tail a running session
 *   validate <session-id>  Check if session completed and output is correct
 *   doctor                 Health-check: provider availability, tool readiness
 */

import { run } from "./commands/run.js";
import { sessions } from "./commands/sessions.js";
import { inspect } from "./commands/inspect.js";
import { tail } from "./commands/tail.js";
import { validate } from "./commands/validate.js";
import { doctor } from "./commands/doctor.js";

const HELP = `
8gent Harness CLI — Headless agent testing & inspection

COMMANDS:
  run <prompt> [options]     Run a headless agent session
    --model <model>          Model to use (default: from env or glm-4.7-flash:latest)
    --runtime <runtime>      Provider: ollama, lmstudio, openrouter (default: ollama)
    --max-steps <n>          Max agentic steps (default: 30)
    --workdir <path>         Working directory (default: cwd)
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
    --follow                 Keep watching for new entries (default: true)

  validate <session-id>      Validate session output
    --expect <substring>     Expect output to contain substring
    --expect-file <path>     Expect file to have been created
    --expect-exit <reason>   Expect exit reason (user_exit, max_steps, etc.)

  doctor                     Health-check providers and tools

EXAMPLES:
  bun run packages/harness-cli/index.ts run "Write a fibonacci function in fib.js"
  bun run packages/harness-cli/index.ts sessions --limit 5
  bun run packages/harness-cli/index.ts inspect session_1710371400_abc123
  bun run packages/harness-cli/index.ts validate session_1710371400_abc123 --expect-file fib.js
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
