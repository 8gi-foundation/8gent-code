#!/usr/bin/env bun
// Quick test: send a message from @eightgentcodebot

const TOKEN = "8651805768:AAFvSVOMc7U9l2itsBUTWPzgBkPxdle4B4U";
const CHAT_ID = "5486040131";

const text = `🤖 *@eightgentcodebot is ALIVE*

_8gent-code competition dashboard initialized._
_Overnight competition infrastructure deployed._
_Standing by for launch._

Commands: /status /scores /compare /help`;

const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: "Markdown" }),
});

const data = await res.json();
console.log(data.ok ? "✅ Bot message sent!" : `❌ Failed: ${JSON.stringify(data)}`);
