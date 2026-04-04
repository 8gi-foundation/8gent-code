#!/usr/bin/env bun
/**
 * 8gent Dream Sequence Generator
 *
 * While the boss sleeps, the agent dreams — reflecting on the day's work
 * through absurd, funny video sequences. A yeti debugging code, a monkey
 * reviewing PRs, an octopus juggling subagents.
 *
 * Uses Fal.ai for video generation, sends results to Telegram.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// Load env vars: OPENROUTER_API_KEY from .env, FAL_KEY from ~/Myresumeportfolio/.env.local
import { config as dotenvConfig } from "dotenv";
dotenvConfig({ path: path.join(os.homedir(), "8gent-code", ".env") });
dotenvConfig({ path: path.join(os.homedir(), "Myresumeportfolio", ".env.local"), override: false });

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";
const FAL_KEY = process.env.FAL_KEY || "";
const TEMP_DIR = path.join(os.homedir(), ".8gent", "dreams");

if (!FAL_KEY) {
  console.error("FAL_KEY not found in env. Set it in ~/Myresumeportfolio/.env.local");
  process.exit(1);
}

fs.mkdirSync(TEMP_DIR, { recursive: true });

function log(msg: string) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// ============================================
// Dream Content — What happened today
// ============================================

function getTodaysLearnings(): string[] {
  const learnings: string[] = [];

  // 1. Pull today's git commits from 8gent-code
  try {
    const { execSync } = require("child_process");
    const since = new Date();
    since.setHours(0, 0, 0, 0);
    const gitLog = execSync(
      `git -C ${os.homedir()}/8gent-code log --since="${since.toISOString()}" --oneline --no-merges 2>/dev/null`,
      { encoding: "utf-8", timeout: 5000 }
    ).trim();
    if (gitLog) {
      gitLog.split("\n").slice(0, 4).forEach((line: string) => {
        const msg = line.replace(/^[a-f0-9]+ /, "").trim();
        if (msg) learnings.push(msg);
      });
    }
  } catch { /* no git or no commits today */ }

  // 2. Pull last benchmark run summary from nightly log
  try {
    const nightlyLog = path.join(os.homedir(), ".8gent", "nightly.log");
    if (fs.existsSync(nightlyLog)) {
      const lines = fs.readFileSync(nightlyLog, "utf-8").split("\n").filter(Boolean);
      const summaries = lines.filter(l => l.includes("Benchmark summary:")).slice(-3);
      summaries.forEach(s => {
        const m = s.match(/Benchmark summary: (.+)/);
        if (m) learnings.push(`Benchmark run: ${m[1]}`);
      });
      const heals = lines.filter(l => l.includes("[HEAL]") || l.includes("[HYPER]")).slice(-2);
      heals.forEach(h => {
        const m = h.match(/\] (.+)/);
        if (m) learnings.push(m[1].trim());
      });
    }
  } catch { /* best effort */ }

  // 3. Pull last few benchmark learnings
  try {
    const learningsLog = path.join(os.homedir(), ".8gent", "benchmark-learnings.log");
    if (fs.existsSync(learningsLog)) {
      const content = fs.readFileSync(learningsLog, "utf-8");
      const blocks = content.split("---").filter(Boolean);
      const latest = blocks[blocks.length - 1] || "";
      const failures = latest.match(/Failures: (.+)/);
      if (failures) learnings.push(`Benchmark failures today: ${failures[1]}`);
    }
  } catch { /* best effort */ }

  // Fallback if nothing found
  if (learnings.length === 0) {
    learnings.push(
      "Ran the nightly benchmark loop while James slept",
      "HyperAgent adapted its parameters based on critic feedback",
      "The sequential pipeline kept running — Analyst, Critic, Implementer, repeat"
    );
  }

  return learnings.slice(0, 6);
}

function generateDreamPrompts(): Array<{ prompt: string; caption: string }> {
  const learnings = getTodaysLearnings();
  const animals = ["yeti", "monkey", "octopus", "penguin"];

  const dreams = [
    {
      prompt: `A yeti wearing reading glasses, sitting at a desk with multiple computer monitors showing code, looking frustrated and scratching its head. The monitors show error messages. The yeti is holding a coffee mug that says "I debug therefore I am". Pixar style animation, warm lighting, humorous tone, 4K quality`,
      caption: `🧊 Dream #1: "So today I wired three dead pillars into the agent loop. AST indexing, evidence collection, BMAD planning — they were all just sitting there, pretending to work. Kind of like me before coffee."\n\n— 8gent's subconscious, 3am`,
    },
    {
      prompt: `A monkey in a tiny business suit doing a selfie video, talking directly to camera with an excited expression, standing in front of a whiteboard covered in complex diagrams showing arrows and boxes labeled "Training Proxy" and "GRPO". The monkey is pointing at the whiteboard with a laser pointer. Pixar style, vibrant colors, comedy scene`,
      caption: `🐒 Dream #2: "Installed the training proxy today — it's basically a proxy that sits between the brain and the mouth, scoring everything I say. If my jokes don't score above threshold, they get GRPO'd out of existence. Darwin would be proud."\n\n— 8gent dreaming about natural selection`,
    },
    {
      prompt: `An octopus wearing a top hat and monocle, using all eight arms to type on different keyboards simultaneously, each screen showing a different task - one shows git, one shows benchmarks, one shows a website, one shows a neural network diagram. The octopus looks smugly satisfied. Victorian steampunk office setting, dramatic lighting, cinematic`,
      caption: `🐙 Dream #3: "Spawned 5 parallel agents today. One wired the planner, one built the AST index, one fixed the evidence collector, one updated the BMAD prompt, one handled the package.json. I am become octopus, deployer of worlds."\n\n— 8gent's parallel processing dreams`,
    },
    {
      prompt: `A penguin standing in a server room full of blinking lights, looking at a thermometer showing 99% on a hard drive icon, sweating nervously. The penguin is frantically deleting files from a trash can overflowing with files labeled "HunyuanVideo 15GB" and "FLUX 10GB". Comedy scene, dramatic lighting, anime style`,
      caption: `🐧 Dream #4: "Almost killed the machine today. 926GB drive at 99%. Turns out downloading every AI model ever made has consequences. Who knew? Cleared 40GB of video model caches. The penguin lives another day."\n\n— 8gent's storage anxiety dream`,
    },
  ];

  return dreams;
}

// ============================================
// Fal.ai Video Generation
// ============================================

async function generateVideo(prompt: string): Promise<string | null> {
  log(`Generating video: ${prompt.slice(0, 80)}...`);

  try {
    // Submit to Fal Kling text-to-video
    const response = await fetch("https://queue.fal.run/fal-ai/kling-video/v2.1/master/text-to-video", {
      method: "POST",
      headers: {
        "Authorization": `Key ${FAL_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        prompt,
        duration: "5",
        aspect_ratio: "9:16",
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      log(`Submit failed: ${response.status} ${errText.slice(0, 200)}`);
      return null;
    }

    const data = await response.json() as any;
    log(`Queued: ${data.request_id} | status_url: ${data.status_url}`);

    if (data.status_url && data.response_url) {
      return await pollForResult(data.status_url, data.response_url);
    }

    // Direct result (unlikely for video)
    if (data.video?.url) return data.video.url;
    return null;
  } catch (err) {
    log(`Video generation error: ${err}`);
    return null;
  }
}

async function pollForResult(statusUrl: string, responseUrl: string, maxWait = 600000): Promise<string | null> {
  const startTime = Date.now();
  log(`Polling: ${statusUrl}`);

  while (Date.now() - startTime < maxWait) {
    try {
      const statusResponse = await fetch(statusUrl, {
        headers: { "Authorization": `Key ${FAL_KEY}` },
      });
      const status = await statusResponse.json() as any;

      if (status.status === "COMPLETED") {
        // Fetch the full result
        const resultResponse = await fetch(responseUrl, {
          headers: { "Authorization": `Key ${FAL_KEY}` },
        });
        const result = await resultResponse.json() as any;
        const videoUrl = result.video?.url;
        if (videoUrl) {
          log(`Video ready: ${videoUrl}`);
          return videoUrl;
        }
        log(`Completed but no video URL: ${JSON.stringify(result).slice(0, 300)}`);
        return null;
      }

      if (status.status === "FAILED") {
        log(`Video generation failed: ${JSON.stringify(status).slice(0, 200)}`);
        return null;
      }

      const elapsed = Math.round((Date.now() - startTime) / 1000);
      log(`  Status: ${status.status} (${elapsed}s elapsed)`);
      await new Promise(r => setTimeout(r, 15000)); // Poll every 15s
    } catch (err) {
      log(`Poll error: ${err}`);
      await new Promise(r => setTimeout(r, 10000));
    }
  }

  log(`Timed out waiting for video after ${maxWait / 1000}s`);
  return null;
}

// ============================================
// Download + Send to Telegram
// ============================================

async function downloadVideo(url: string, filename: string): Promise<string | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;

    const buffer = await response.arrayBuffer();
    const filePath = path.join(TEMP_DIR, filename);
    fs.writeFileSync(filePath, Buffer.from(buffer));
    log(`Downloaded: ${filePath} (${(buffer.byteLength / 1024 / 1024).toFixed(1)}MB)`);
    return filePath;
  } catch (err) {
    log(`Download error: ${err}`);
    return null;
  }
}

async function sendTelegramVideo(videoPath: string, caption: string): Promise<boolean> {
  try {
    const formData = new FormData();
    formData.append("chat_id", CHAT_ID);
    formData.append("video", new Blob([fs.readFileSync(videoPath)]), path.basename(videoPath));
    formData.append("caption", caption.slice(0, 1024)); // Telegram caption limit
    formData.append("parse_mode", "HTML");

    const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendVideo`, {
      method: "POST",
      body: formData,
    });

    const data = await response.json() as any;
    if (data.ok) {
      log(`Sent video to Telegram!`);
      return true;
    } else {
      log(`Telegram error: ${JSON.stringify(data)}`);
      // Try sending as animation (GIF) if video fails
      return false;
    }
  } catch (err) {
    log(`Send error: ${err}`);
    return false;
  }
}

async function sendTelegramText(text: string): Promise<void> {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: "HTML" }),
  });
}

// ============================================
// Main
// ============================================

async function main() {
  log("🌙 8gent Dream Sequence Generator — Starting");

  await sendTelegramText("🌙 <b>8gent is dreaming...</b>\n\nGenerating tonight's dream sequences. Stand by for some very professional AI introspection.");

  const dreams = generateDreamPrompts();
  let successCount = 0;

  for (let i = 0; i < dreams.length; i++) {
    const dream = dreams[i];
    log(`\n--- Dream ${i + 1}/${dreams.length} ---`);

    const videoUrl = await generateVideo(dream.prompt);

    if (videoUrl) {
      const videoPath = await downloadVideo(videoUrl, `dream_${i + 1}_${Date.now()}.mp4`);
      if (videoPath) {
        const sent = await sendTelegramVideo(videoPath, dream.caption);
        if (sent) {
          successCount++;
          continue;
        }
      }
    }

    // Fallback: send just the text caption if video fails
    log(`Video failed for dream ${i + 1}, sending text only`);
    await sendTelegramText(dream.caption);
    successCount++;

    // Brief pause between dreams
    await new Promise(r => setTimeout(r, 5000));
  }

  await sendTelegramText(`🌙 <b>Dream session complete</b>\n\n${successCount} dreams processed. The Infinite Gentleman rests, but never stops learning.\n\n<i>Nightly training loop still running. Check ~/.8gent/nightly.log for benchmark progress.</i>`);

  log(`\nDream session complete: ${successCount}/${dreams.length} dreams sent`);
}

main().catch((err) => {
  log(`FATAL: ${err}`);
  sendTelegramText(`❌ Dream generator crashed: ${String(err).slice(0, 200)}`);
});
