#!/usr/bin/env bun
/**
 * Send branch reports to Telegram + generate TTS audio
 */

import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";

const TOKEN = "8651805768:AAFvSVOMc7U9l2itsBUTWPzgBkPxdle4B4U";
const CHAT_ID = "5486040131";
const AUDIO_DIR = join(import.meta.dir, "../docs/branch-audio");

async function send(text: string) {
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: "Markdown", disable_web_page_preview: true }),
  });
  const data = await res.json() as any;
  if (!data.ok) {
    // Retry without markdown
    await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: CHAT_ID, text }),
    });
  }
}

async function sendAudio(filePath: string, caption: string) {
  // Generate audio with macOS say
  const wavPath = filePath.replace(".txt", ".aiff");
  const text = readFileSync(filePath, "utf-8").slice(0, 350); // TTS limit
  try {
    execSync(`say -v Ava -o "${wavPath}" "${text.replace(/"/g, '\\"')}"`, { timeout: 30000 });

    // Send as voice message
    const form = new FormData();
    form.append("chat_id", CHAT_ID);
    form.append("caption", caption);
    form.append("voice", new Blob([readFileSync(wavPath)]), "voice.aiff");

    await fetch(`https://api.telegram.org/bot${TOKEN}/sendVoice`, {
      method: "POST",
      body: form,
    });
  } catch (err) {
    console.log(`Audio failed for ${filePath}, sending text instead`);
    await send(`🔊 *Audio Report:*\n${text}`);
  }
}

// Send overview first
await send(`📋 *14 FEATURE BRANCH REPORTS*
━━━━━━━━━━━━━━━━━━━━━━━━━

🟢 *SAFE TO MERGE (6):*
├ nemoclaw-policy-engine
├ openviktor-github-deep
├ hypothesis-loop
├ cashclaw-knowledge-system
├ remote-monitor-memory
└ agent-browser-integration

🟡 *MERGE WITH CAUTION (3):*
├ hermes-self-evolution (overlaps memory-v2)
├ blast-radius-engine (overlaps jcodemunch)
└ worktree-swarm (security + race conditions)

🗑️ *STALE — DELETE (5):*
├ knowledge-graph (already merged)
├ memory-v2-core (already merged)
├ session-convex-sync (already merged)
├ stripe-billing (already merged)
└ tenant-convex-persistence (already merged)

📊 *7,200+ lines of new code*
🎯 *Recommended merge order below*`);

await new Promise(r => setTimeout(r, 1000));

// Send recommended merge order
await send(`🔀 *RECOMMENDED MERGE ORDER*
━━━━━━━━━━━━━━━━━━━━━━━━━

*1. nemoclaw-policy-engine* 🛡️
Security foundation — all other features benefit from policy enforcement

*2. openviktor-github-deep* 🐙
Multi-provider LLM + GitHub workflow — infrastructure layer

*3. hypothesis-loop* ⚗️
Core differentiator — atomic commit-verify-revert with self-healing

*4. blast-radius-engine* 📡
Token savings — 5-50x reduction via targeted context

*5. cashclaw-knowledge-system* 🧠
Learning layer — BM25+ search + feedback loops

*6. remote-monitor-memory* 📱
UX upgrade — watch agent from phone + frequency memory

*7. agent-browser-integration* 🌐
Web capability — research + testing

*8. hermes-self-evolution* 🧬
Needs dedup with existing memory packages first

*9. worktree-swarm* 🤖
Most complex — merge last, needs security review`);

await new Promise(r => setTimeout(r, 1000));

// Send individual audio reports
const files = readdirSync(AUDIO_DIR).filter(f => f.endsWith(".txt")).sort();
for (const file of files) {
  const text = readFileSync(join(AUDIO_DIR, file), "utf-8");
  const num = file.split("-")[0];
  const name = file.replace(/^\d+-/, "").replace(".txt", "");

  // Send as text (Telegram voice requires opus/ogg format)
  await send(`🔊 *Branch ${num}: ${name}*\n\n${text}`);
  await new Promise(r => setTimeout(r, 500));
}

// Generate combined audio file
try {
  const allText = files.map(f => readFileSync(join(AUDIO_DIR, f), "utf-8")).join("\n\nNext branch.\n\n");
  const combinedPath = join(AUDIO_DIR, "all-branches-combined.aiff");
  execSync(`say -v Ava -o "${combinedPath}" "${allText.slice(0, 3000).replace(/"/g, '\\"')}"`, { timeout: 120000 });
  console.log(`Combined audio saved: ${combinedPath}`);
} catch {
  console.log("Combined audio generation failed (text too long)");
}

await send(`✅ *All 14 branch reports sent.*
Audio files saved at: docs/branch-audio/

_Ready to merge when you are, James._`);

console.log("Done!");
