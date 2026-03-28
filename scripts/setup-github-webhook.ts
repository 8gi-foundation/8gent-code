#!/usr/bin/env bun
/**
 * Setup GitHub -> Discord webhook for the #prs channel.
 *
 * Reads DISCORD_8CO_BOT_TOKEN from .env, finds the #prs channel,
 * creates a webhook named "GitHub", and stores the URL in .env
 * as DISCORD_GITHUB_WEBHOOK_URL.
 */

import { readFileSync, appendFileSync, writeFileSync } from "fs";
import { resolve } from "path";

const ENV_PATH = resolve(import.meta.dir, "../.env");

// Load .env manually
const envContent = readFileSync(ENV_PATH, "utf-8");
const envVars: Record<string, string> = {};
for (const line of envContent.split("\n")) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) continue;
  const eqIdx = trimmed.indexOf("=");
  if (eqIdx === -1) continue;
  envVars[trimmed.slice(0, eqIdx)] = trimmed.slice(eqIdx + 1);
}

const BOT_TOKEN = envVars.DISCORD_8CO_BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error("DISCORD_8CO_BOT_TOKEN not found in .env");
  process.exit(1);
}

const API = "https://discord.com/api/v10";
const headers = {
  Authorization: `Bot ${BOT_TOKEN}`,
  "Content-Type": "application/json",
};

async function api(path: string, opts?: RequestInit) {
  const res = await fetch(`${API}${path}`, { ...opts, headers });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Discord API ${res.status}: ${body}`);
  }
  return res.json();
}

// Step 1: Get guilds the bot is in
console.log("Fetching guilds...");
const guilds = await api("/users/@me/guilds");
if (!guilds.length) {
  console.error("Bot is not in any guilds.");
  process.exit(1);
}

console.log(`Found ${guilds.length} guild(s):`);
for (const g of guilds) {
  console.log(`  - ${g.name} (${g.id})`);
}

// Step 2: Find #prs channel in each guild
let prsChannel: { id: string; name: string; guild_id: string } | null = null;

for (const guild of guilds) {
  console.log(`\nSearching channels in "${guild.name}"...`);
  const channels = await api(`/guilds/${guild.id}/channels`);
  for (const ch of channels) {
    // Type 0 = text channel
    if (ch.type === 0) {
      console.log(`  #${ch.name} (${ch.id})`);
    }
    if (ch.name === "prs" && ch.type === 0) {
      prsChannel = { id: ch.id, name: ch.name, guild_id: guild.id };
    }
  }
}

if (!prsChannel) {
  console.error("\nNo #prs channel found in any guild.");
  console.log("Available text channels are listed above.");
  process.exit(1);
}

console.log(`\nFound #prs channel: ${prsChannel.id} in guild ${prsChannel.guild_id}`);

// Step 3: Create webhook
console.log("Creating webhook...");
const webhook = await api(`/channels/${prsChannel.id}/webhooks`, {
  method: "POST",
  body: JSON.stringify({
    name: "GitHub",
  }),
});

const webhookUrl = `https://discord.com/api/webhooks/${webhook.id}/${webhook.token}`;
console.log(`\nWebhook created successfully!`);
console.log(`Webhook ID: ${webhook.id}`);
console.log(`Webhook URL: ${webhookUrl}`);
console.log(`GitHub-compatible URL: ${webhookUrl}/github`);

// Step 4: Store in .env
const envKey = "DISCORD_GITHUB_WEBHOOK_URL";
if (envContent.includes(envKey)) {
  // Replace existing
  const updated = envContent.replace(
    new RegExp(`^${envKey}=.*$`, "m"),
    `${envKey}=${webhookUrl}`
  );
  writeFileSync(ENV_PATH, updated);
  console.log(`\nUpdated ${envKey} in .env`);
} else {
  appendFileSync(ENV_PATH, `\n# GitHub -> Discord webhook for #prs\n${envKey}=${webhookUrl}\n`);
  console.log(`\nAppended ${envKey} to .env`);
}

console.log("\nDone. See scripts/discord-github-bridge.md for GitHub setup instructions.");
