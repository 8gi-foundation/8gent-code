/**
 * Audit CLI - `8gent audit <session-id>`
 *
 * Inspect, verify, and query immutable session logs.
 *
 * Commands:
 *   8gent audit list                  - List all session IDs
 *   8gent audit <session-id>          - Print all entries
 *   8gent audit <session-id> verify   - Verify checksum chain
 *   8gent audit <session-id> summary  - Print step count and status
 *   8gent audit <session-id> tail N   - Print last N entries
 *
 * Issue: #1402
 */

import { openSession, listSessions, getSessionsDir } from "./session";
import type { AuditEntry } from "./types";

/** Format a single audit entry for terminal display. */
function formatEntry(entry: AuditEntry, index: number): string {
  const time = entry.timestamp.replace("T", " ").replace(/\.\d+Z$/, "Z");
  const hashShort = entry.hash.slice(0, 12);
  const lines = [`  #${index} [${time}] ${entry.type} (${hashShort})`];

  // Show relevant payload fields based on type
  switch (entry.type) {
    case "decision":
      lines.push(`    tool: ${entry.payload.tool}`);
      if (entry.payload.reasoning) {
        lines.push(`    why:  ${String(entry.payload.reasoning).slice(0, 120)}`);
      }
      break;
    case "tool_result":
      lines.push(`    tool: ${entry.payload.tool} ${entry.payload.success ? "OK" : "FAIL"}`);
      if (entry.payload.error) {
        lines.push(`    err:  ${String(entry.payload.error).slice(0, 120)}`);
      }
      break;
    case "error":
      lines.push(`    phase: ${entry.payload.phase}`);
      lines.push(`    err:   ${String(entry.payload.error).slice(0, 120)}`);
      break;
    case "session_start":
      lines.push(`    tools: ${entry.payload.tools}`);
      lines.push(`    maxSteps: ${entry.payload.maxSteps}`);
      break;
    case "session_end":
      lines.push(`    steps: ${entry.payload.steps}, completed: ${entry.payload.completed}`);
      break;
    default:
      // Generic payload display
      for (const [k, v] of Object.entries(entry.payload)) {
        lines.push(`    ${k}: ${JSON.stringify(v).slice(0, 100)}`);
      }
  }

  return lines.join("\n");
}

/** Run the audit CLI with the given arguments. */
export async function runAuditCLI(args: string[]): Promise<void> {
  if (args.length === 0 || args[0] === "help" || args[0] === "--help") {
    console.log(`
8gent audit - Inspect immutable session logs

Usage:
  8gent audit list                  List all session IDs
  8gent audit <session-id>          Print all entries
  8gent audit <session-id> verify   Verify checksum chain integrity
  8gent audit <session-id> summary  Print step count and status
  8gent audit <session-id> tail N   Print last N entries (default: 10)

Sessions stored in: ${getSessionsDir()}
`.trim());
    return;
  }

  // List command
  if (args[0] === "list") {
    const sessions = listSessions();
    if (sessions.length === 0) {
      console.log("No audit sessions found.");
      return;
    }
    console.log(`${sessions.length} session(s):\n`);
    for (const sid of sessions) {
      console.log(`  ${sid}`);
    }
    return;
  }

  // Session-specific commands
  const sessionId = args[0];
  const subcommand = args[1] || "print";

  let session;
  try {
    session = openSession(sessionId);
  } catch {
    console.error(`Session not found: ${sessionId}`);
    console.error(`Run "8gent audit list" to see available sessions.`);
    process.exit(1);
  }

  const entries = await session.readAll();

  switch (subcommand) {
    case "print": {
      if (entries.length === 0) {
        console.log(`Session ${sessionId}: empty`);
        return;
      }
      console.log(`Session ${sessionId} (${entries.length} entries):\n`);
      for (let i = 0; i < entries.length; i++) {
        console.log(formatEntry(entries[i], i));
      }
      break;
    }

    case "verify": {
      const brokenAt = await session.verify();
      if (brokenAt === -1) {
        console.log(`Session ${sessionId}: chain integrity VALID (${entries.length} entries)`);
      } else {
        console.error(`Session ${sessionId}: chain BROKEN at entry #${brokenAt}`);
        console.error(`Entry: ${JSON.stringify(entries[brokenAt], null, 2)}`);
        process.exit(1);
      }
      break;
    }

    case "summary": {
      const decisions = entries.filter((e) => e.type === "decision");
      const results = entries.filter((e) => e.type === "tool_result");
      const errors = entries.filter((e) => e.type === "error");
      const successes = results.filter((e) => e.payload.success === true);
      const failures = results.filter((e) => e.payload.success === false);
      const endEntry = entries.find((e) => e.type === "session_end");

      console.log(`Session ${sessionId}:`);
      console.log(`  Entries:    ${entries.length}`);
      console.log(`  Decisions:  ${decisions.length}`);
      console.log(`  Successes:  ${successes.length}`);
      console.log(`  Failures:   ${failures.length}`);
      console.log(`  Errors:     ${errors.length}`);
      console.log(`  Completed:  ${endEntry ? endEntry.payload.completed : "in progress"}`);
      if (entries.length > 0) {
        console.log(`  First:      ${entries[0].timestamp}`);
        console.log(`  Last:       ${entries[entries.length - 1].timestamp}`);
      }
      break;
    }

    case "tail": {
      const n = parseInt(args[2] || "10", 10);
      const start = Math.max(0, entries.length - n);
      if (entries.length === 0) {
        console.log(`Session ${sessionId}: empty`);
        return;
      }
      console.log(`Session ${sessionId} (last ${Math.min(n, entries.length)} of ${entries.length}):\n`);
      for (let i = start; i < entries.length; i++) {
        console.log(formatEntry(entries[i], i));
      }
      break;
    }

    default:
      console.error(`Unknown subcommand: ${subcommand}`);
      console.error(`Run "8gent audit help" for usage.`);
      process.exit(1);
  }
}
