#!/usr/bin/env bun
/**
 * @8gent/telegram-bot — Cron Installer
 *
 * Installs (or removes) the nightly intelligence cron job.
 * Usage:
 *   bun run install-cron.ts          # install
 *   bun run install-cron.ts --remove # remove
 */

const BUN_PATH = "/Users/jamesspalding/.bun/bin/bun";
const SCRIPT_PATH = "/Users/jamesspalding/8gent-code/packages/telegram-bot/cron-intelligence.ts";
const LOG_PATH = "/Users/jamesspalding/.8gent/intelligence/cron.log";
const CRON_SCHEDULE = "0 3 * * *";
const CRON_LINE = `${CRON_SCHEDULE} ${BUN_PATH} ${SCRIPT_PATH} >> ${LOG_PATH} 2>&1`;
const CRON_MARKER = "8gent-intelligence";

async function getCurrentCrontab(): Promise<string> {
  try {
    const proc = Bun.spawn(["crontab", "-l"], { stdout: "pipe", stderr: "pipe" });
    const text = await new Response(proc.stdout).text();
    return text;
  } catch {
    return "";
  }
}

async function setCrontab(content: string): Promise<void> {
  const proc = Bun.spawn(["crontab", "-"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const writer = proc.stdin.getWriter();
  await writer.write(new TextEncoder().encode(content));
  await writer.close();
  await proc.exited;
}

async function install(): Promise<void> {
  const current = await getCurrentCrontab();

  // Check if already installed
  if (current.includes(CRON_MARKER)) {
    console.log("[install-cron] Cron job already installed. Updating...");
    // Remove old entry first
    const filtered = current
      .split("\n")
      .filter((line) => !line.includes(CRON_MARKER))
      .join("\n");
    const updated = `${filtered.trimEnd()}\n# ${CRON_MARKER}\n${CRON_LINE}\n`;
    await setCrontab(updated);
    console.log("[install-cron] Updated cron job.");
  } else {
    const updated = `${current.trimEnd()}\n# ${CRON_MARKER}\n${CRON_LINE}\n`;
    await setCrontab(updated);
    console.log("[install-cron] Installed cron job.");
  }

  console.log(`[install-cron] Schedule: ${CRON_SCHEDULE} (3 AM daily)`);
  console.log(`[install-cron] Script: ${SCRIPT_PATH}`);
  console.log(`[install-cron] Log: ${LOG_PATH}`);
}

async function remove(): Promise<void> {
  const current = await getCurrentCrontab();

  if (!current.includes(CRON_MARKER)) {
    console.log("[install-cron] No cron job found to remove.");
    return;
  }

  const filtered = current
    .split("\n")
    .filter((line) => !line.includes(CRON_MARKER))
    .join("\n");

  await setCrontab(filtered.trimEnd() + "\n");
  console.log("[install-cron] Removed cron job.");
}

// ── Main ────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args.includes("--remove") || args.includes("-r")) {
  await remove();
} else {
  await install();
}
