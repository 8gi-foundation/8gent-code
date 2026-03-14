/**
 * harness-cli: sessions command
 *
 * List all sessions with summaries.
 */

import { listSessions } from "../../specifications/session/reader.js";

interface SessionsOptions {
  limit: number;
  json: boolean;
  filter: "all" | "completed" | "failed" | "running";
}

function parseArgs(args: string[]): SessionsOptions {
  const opts: SessionsOptions = { limit: 20, json: false, filter: "all" };
  let i = 0;
  while (i < args.length) {
    switch (args[i]) {
      case "--limit":
        opts.limit = parseInt(args[++i], 10);
        break;
      case "--json":
        opts.json = true;
        break;
      case "--filter":
        opts.filter = args[++i] as SessionsOptions["filter"];
        break;
    }
    i++;
  }
  return opts;
}

export async function sessions(args: string[]): Promise<void> {
  const opts = parseArgs(args);
  let all = await listSessions();

  // Filter
  if (opts.filter === "completed") {
    all = all.filter(s => s.completed && s.exitReason !== "error");
  } else if (opts.filter === "failed") {
    all = all.filter(s => s.completed && s.exitReason === "error");
  } else if (opts.filter === "running") {
    all = all.filter(s => !s.completed);
  }

  const shown = all.slice(0, opts.limit);

  if (opts.json) {
    console.log(JSON.stringify(shown, null, 2));
    return;
  }

  if (shown.length === 0) {
    console.log("No sessions found.");
    return;
  }

  console.log(`\n  Sessions (${shown.length} of ${all.length})\n`);
  console.log(
    "  " +
    "ID".padEnd(36) +
    "Status".padEnd(12) +
    "Steps".padEnd(7) +
    "Duration".padEnd(10) +
    "Model".padEnd(25) +
    "Preview"
  );
  console.log("  " + "─".repeat(110));

  for (const s of shown) {
    const status = s.completed
      ? s.exitReason === "error" ? "FAILED" : "DONE"
      : "RUNNING";
    const statusColor = status === "DONE" ? "\x1b[32m" : status === "FAILED" ? "\x1b[31m" : "\x1b[33m";
    const reset = "\x1b[0m";

    const duration = s.durationMs
      ? `${(s.durationMs / 1000).toFixed(1)}s`
      : "—";

    const steps = s.totalSteps !== null ? String(s.totalSteps) : "—";
    const model = s.model?.slice(0, 23) || "—";
    const preview = s.firstUserMessage?.slice(0, 40) || "—";

    console.log(
      "  " +
      s.sessionId.slice(0, 34).padEnd(36) +
      `${statusColor}${status.padEnd(12)}${reset}` +
      steps.padEnd(7) +
      duration.padEnd(10) +
      model.padEnd(25) +
      preview
    );
  }

  console.log();
}
