#!/usr/bin/env bun
import { readFileSync } from "fs";
import { execSync } from "child_process";
import { join } from "path";

const TOKEN = "8651805768:AAFvSVOMc7U9l2itsBUTWPzgBkPxdle4B4U";
const CHAT_ID = "5486040131";
const AUDIO_DIR = join(import.meta.dir, "../docs/content/audio");

async function send(text: string) {
  await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: "Markdown", disable_web_page_preview: true }),
  });
}

async function sendAudio(text: string, label: string) {
  const safePath = join(AUDIO_DIR, `${label}.aiff`);
  const safe = text.replace(/"/g, '\\"').replace(/\n/g, ' ').slice(0, 2000);
  try {
    execSync(`mkdir -p "${AUDIO_DIR}"`);
    execSync(`say -v Moira -o "${safePath}" "${safe}"`, { timeout: 60000 });

    const form = new FormData();
    form.append("chat_id", CHAT_ID);
    form.append("caption", `🔊 ${label}`);
    form.append("voice", new Blob([readFileSync(safePath)]), "voice.aiff");
    await fetch(`https://api.telegram.org/bot${TOKEN}/sendVoice`, { method: "POST", body: form });
  } catch (err: any) {
    console.log(`Audio failed for ${label}: ${err.message}`);
    await send(`🔊 *${label}:*\n\n${text}`);
  }
}

// Parse the content file
const content = readFileSync(join(import.meta.dir, "../docs/content/2026-03-20-day1-launch.md"), "utf-8");
const sections = content.split("---").filter(s => s.trim());

// Extract each platform's post
const linkedin = sections.find(s => s.includes("## LinkedIn"))?.replace("## LinkedIn", "").trim() || "";
const twitter = sections.find(s => s.includes("## X / Twitter"))?.replace("## X / Twitter", "").trim() || "";
const threads = sections.find(s => s.includes("## Threads"))?.replace("## Threads / Instagram", "").trim() || "";
const artem = sections.find(s => s.includes("## Artem"))?.replace("## Artem Luko Reply (LinkedIn - AI Perks)", "").trim() || "";

// Send to Telegram
await send("📝 *DAY 1 — CONTENT DRAFTS*\n━━━━━━━━━━━━━━━━━━━━━━━━━");
await new Promise(r => setTimeout(r, 500));

await send(`📘 *LINKEDIN:*\n\n${linkedin}`);
await new Promise(r => setTimeout(r, 500));

await send(`🐦 *X / TWITTER:*\n\n${twitter}`);
await new Promise(r => setTimeout(r, 500));

await send(`🧵 *THREADS / INSTAGRAM:*\n\n${threads}`);
await new Promise(r => setTimeout(r, 500));

await send(`💬 *ARTEM LUKO REPLY:*\n\n${artem}`);
await new Promise(r => setTimeout(r, 1000));

// Generate and send audio for each
await sendAudio(linkedin, "LinkedIn-Day1");
await new Promise(r => setTimeout(r, 500));

await sendAudio(twitter, "Twitter-Day1");
await new Promise(r => setTimeout(r, 500));

await sendAudio(threads, "Threads-Day1");
await new Promise(r => setTimeout(r, 500));

await sendAudio(artem, "ArtemReply-Day1");

await send("✅ All drafts sent with audio. Listen, review, post when ready.");

console.log("Done!");
