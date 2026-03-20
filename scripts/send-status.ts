#!/usr/bin/env bun
// Send overnight competition status to @eightgentcodebot

const TOKEN = "8651805768:AAFvSVOMc7U9l2itsBUTWPzgBkPxdle4B4U";
const CHAT_ID = "5486040131";

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
