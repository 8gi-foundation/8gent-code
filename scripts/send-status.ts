#!/usr/bin/env bun
// Send overnight competition status to @eightgentcodebot

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
if (!TOKEN || !CHAT_ID) { console.error("TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID required in .env"); process.exit(1); }

async function send(text: string) {
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: "Markdown" }),
  });
  const data = await res.json();
  if (!data.ok) console.error("Send failed:", data.description);
  return data.ok;
}

const msg = process.argv[2] || "No message provided";
await send(msg);
