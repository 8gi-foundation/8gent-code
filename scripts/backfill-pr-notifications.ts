#!/usr/bin/env bun
/**
 * Backfill Telegram notifications for existing PRs.
 * Reads PR list from GitHub, generates a pitch for each,
 * sends to Telegram with a delay between each to avoid flooding.
 *
 * Usage:
 *   bun run scripts/backfill-pr-notifications.ts
 *   bun run scripts/backfill-pr-notifications.ts --start 1 --end 100
 *   bun run scripts/backfill-pr-notifications.ts --delay 30
 */

import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";

const TELEGRAM_CHAT_ID = "5486040131";
const DELAY_SECONDS = parseInt(process.argv.find(a => a.startsWith("--delay="))?.split("=")[1] ?? "15", 10);
const START = parseInt(process.argv.find(a => a.startsWith("--start="))?.split("=")[1] ?? "1", 10);
const END = parseInt(process.argv.find(a => a.startsWith("--end="))?.split("=")[1] ?? "9999", 10);

function getTelegramToken(): string | null {
  if (process.env.TELEGRAM_BOT_TOKEN) return process.env.TELEGRAM_BOT_TOKEN;
  try {
    const envPath = path.join(process.env.HOME ?? "", ".claude", ".env");
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, "utf-8");
      const match = content.match(/TELEGRAM_BOT_TOKEN=(\S+)/);
      if (match) return match[1];
    }
  } catch {}
  return null;
}

async function sendTelegram(message: string): Promise<void> {
  const token = getTelegramToken();
  if (!token) { console.error("No Telegram token"); process.exit(1); }
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: message, parse_mode: "Markdown" }),
  });
  if (!res.ok) console.error(`Telegram error: ${res.status}`);
}

async function sendVoice(text: string, name: string): Promise<void> {
  const token = getTelegramToken();
  if (!token) return;
  try {
    const aiffPath = `/tmp/8gent-backfill-${name}.aiff`;
    const oggPath = `/tmp/8gent-backfill-${name}.ogg`;
    execSync(`say -v Ava -o "${aiffPath}" "${text.replace(/"/g, '\\"')}"`, { stdio: "pipe" });
    execSync(`ffmpeg -y -i "${aiffPath}" -c:a libopus "${oggPath}" 2>/dev/null`, { stdio: "pipe" });
    if (fs.existsSync(oggPath)) {
      const form = new FormData();
      form.append("chat_id", TELEGRAM_CHAT_ID);
      form.append("voice", new Blob([fs.readFileSync(oggPath)], { type: "audio/ogg" }), "voice.ogg");
      await fetch(`https://api.telegram.org/bot${token}/sendVoice`, { method: "POST", body: form });
      fs.unlinkSync(aiffPath);
      fs.unlinkSync(oggPath);
    }
  } catch {}
}

interface PR {
  number: number;
  title: string;
  headRefName: string;
  body: string;
  url: string;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function main() {
  console.log(`Fetching PRs ${START}-${END}...`);

  // Fetch all PRs in batches
  const allPRs: PR[] = [];
  let page = 1;
  while (true) {
    const result = execSync(
      `gh pr list --state all --limit 100 --json number,title,headRefName,body,url --jq '.' 2>/dev/null`,
      { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 }
    );
    const batch: PR[] = JSON.parse(result);
    allPRs.push(...batch);
    if (batch.length < 100) break;
    page++;
  }

  const filtered = allPRs
    .filter(pr => pr.number >= START && pr.number <= END)
    .sort((a, b) => a.number - b.number);

  console.log(`Found ${filtered.length} PRs to notify about.`);

  // Track progress
  const logPath = path.join(__dirname, "backfill-log.json");
  let done: Set<number>;
  try {
    const existing = JSON.parse(fs.readFileSync(logPath, "utf-8"));
    done = new Set(existing);
  } catch {
    done = new Set();
  }

  let sent = 0;
  for (const pr of filtered) {
    if (done.has(pr.number)) {
      continue;
    }

    const name = pr.headRefName.replace("quarantine/", "");
    const isQuarantine = pr.headRefName.startsWith("quarantine/");

    const msg = isQuarantine
      ? `*PR #${pr.number}: ${pr.title}*\n\nAbility: \`${name}\`\n${pr.body?.slice(0, 200) || pr.title}\n\n*Why it matters:* Another zero-dep utility in Eight's toolkit. Each ability makes the agent more self-sufficient.\n\n${pr.url}`
      : `*PR #${pr.number}: ${pr.title}*\n\n${pr.body?.slice(0, 200) || pr.title}\n\n${pr.url}`;

    console.log(`[${pr.number}] Sending: ${pr.title}`);
    await sendTelegram(msg);

    // Voice pitch for quarantine PRs only
    if (isQuarantine) {
      const voiceText = `PR ${pr.number}. New ability: ${name}. ${pr.title}. Eight grows stronger.`;
      await sendVoice(voiceText, `pr-${pr.number}`);
    }

    done.add(pr.number);
    fs.writeFileSync(logPath, JSON.stringify([...done]), "utf-8");
    sent++;

    if (sent % 25 === 0) {
      console.log(`Progress: ${sent} notifications sent.`);
    }

    await sleep(DELAY_SECONDS * 1000);
  }

  console.log(`Done. Sent ${sent} notifications.`);
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
