#!/usr/bin/env bun
import { readFileSync } from "fs";
import { join } from "path";
import * as os from "os";

const TOKEN = "8651805768:AAFvSVOMc7U9l2itsBUTWPzgBkPxdle4B4U";
const CHAT_ID = "5486040131";

async function send(text: string) {
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: CHAT_ID, text, disable_web_page_preview: true }),
  });
  const d = await res.json() as any;
  console.log(d.ok ? "OK" : `FAIL: ${d.description}`);
}

const file = join(os.homedir(), "Myresumeportfolio/content/daily-posts/2026-03-20/2026-03-20-day1-launch.md");
const raw = readFileSync(file, "utf-8");

// Split by ## headers
const sections = raw.split(/^## /m).slice(1); // skip title

for (const section of sections) {
  const lines = section.split("\n");
  const header = lines[0].trim();
  const body = lines.slice(1).join("\n").replace(/^---$/m, "").trim();
  if (!body) continue;

  await send(`=== ${header.toUpperCase()} ===\n\n${body}`);
  await new Promise(r => setTimeout(r, 1000));
}

await send("Website review notes:\n\n1. Landing page is solid but missing the origin story (the Claude Code frustration). Consider adding it to the hero.\n2. Remove dollar figures from benchmarking page.\n3. 8gent OS / Jr links - either remove or clearly label 'coming soon'.\n4. Personal LoRA 'Q2 2026' preview note is honest - keep it.\n\nPosts above are ready to publish. Text only, no audio.");

console.log("All sent.");
