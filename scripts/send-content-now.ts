#!/usr/bin/env bun
import { readFileSync } from "fs";
import { execSync } from "child_process";
import { join } from "path";

const TOKEN = "8651805768:AAFvSVOMc7U9l2itsBUTWPzgBkPxdle4B4U";
const CHAT_ID = "5486040131";

async function send(text: string) {
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: CHAT_ID, text, disable_web_page_preview: true }),
  });
  const d = await res.json() as any;
  if (!d.ok) console.error("FAILED:", d.description);
  else console.log("Sent message OK");
}

async function sendAudio(text: string, label: string) {
  const path = `/tmp/${label}.aiff`;
  const safe = text.replace(/"/g, "'").replace(/\n/g, " ").slice(0, 1500);
  try {
    execSync(`say -v Moira -o "${path}" "${safe}"`, { timeout: 60000 });
    const form = new FormData();
    form.append("chat_id", CHAT_ID);
    form.append("caption", label);
    form.append("voice", new Blob([readFileSync(path)]), "voice.aiff");
    const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendVoice`, { method: "POST", body: form });
    const d = await res.json() as any;
    if (!d.ok) console.error(`Audio failed: ${d.description}`);
    else console.log(`Sent audio: ${label}`);
  } catch (e: any) {
    console.error(`TTS failed: ${e.message}`);
  }
}

const os = await import("os");
const content = readFileSync(join(os.default.homedir(), "Myresumeportfolio/content/daily-posts/2026-03-20/2026-03-20-day1-launch.md"), "utf-8");

// Split by --- and extract sections
const parts = content.split(/^---$/m).map(s => s.trim()).filter(Boolean);
const linkedin = parts.find(s => s.startsWith("## LinkedIn"))?.replace("## LinkedIn", "").trim() || "";
const twitter = parts.find(s => s.startsWith("## X / Twitter"))?.replace("## X / Twitter", "").trim() || "";
const threads = parts.find(s => s.startsWith("## Threads / Instagram"))?.replace("## Threads / Instagram", "").trim() || "";
const artem = parts.find(s => s.startsWith("## Artem"))?.replace(/## Artem.*/, "").trim() || "";

await send("DAY 1 CONTENT DRAFTS\n====================\n\nLINKEDIN:\n\n" + linkedin);
await new Promise(r => setTimeout(r, 1000));
await send("X / TWITTER:\n\n" + twitter);
await new Promise(r => setTimeout(r, 1000));
await send("THREADS / INSTAGRAM:\n\n" + threads);
await new Promise(r => setTimeout(r, 1000));
await send("ARTEM LUKO REPLY:\n\n" + artem);
await new Promise(r => setTimeout(r, 1000));

await sendAudio(linkedin, "LinkedIn-Day1");
await new Promise(r => setTimeout(r, 500));
await sendAudio(twitter, "Twitter-Day1");
await new Promise(r => setTimeout(r, 500));
await sendAudio(threads, "Threads-Day1");
await new Promise(r => setTimeout(r, 500));
await sendAudio(artem, "ArtemReply-Day1");

console.log("All done.");
