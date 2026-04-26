/**
 * Create a one-time Discord invite link for the 8GI Foundation server.
 * Usage: bun run scripts/create-discord-invite.ts
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const envPath = join(process.env.HOME!, "8gi-governance/.env");
const envContent = readFileSync(envPath, "utf-8");
const vars: Record<string, string> = {};
for (const line of envContent.split("\n")) {
	const match = line.match(/^([A-Z0-9_]+)=(.+)$/);
	if (match) vars[match[1]] = match[2];
}

const token = vars.DISCORD_8CO_BOT_TOKEN;
if (!token) {
	console.error("No DISCORD_8CO_BOT_TOKEN found");
	process.exit(1);
}

const API = "https://discord.com/api/v10";
const headers = {
	Authorization: `Bot ${token}`,
	"Content-Type": "application/json",
	"User-Agent": "DiscordBot (https://8gent.dev, 1.0)",
};

// 1. Get guilds
const guildsRes = await fetch(`${API}/users/@me/guilds`, { headers });
const guilds = (await guildsRes.json()) as Array<{ id: string; name: string }>;
console.log("Guilds:", guilds.map((g) => `${g.name} (${g.id})`).join(", "));

if (guilds.length === 0) {
	console.error("Bot is not in any guilds");
	process.exit(1);
}

const guild = guilds[0];

// 2. Get channels
const channelsRes = await fetch(`${API}/guilds/${guild.id}/channels`, {
	headers,
});
const channels = (await channelsRes.json()) as Array<{
	id: string;
	name: string;
	type: number;
}>;

// Find #introductions or first text channel
const introChannel = channels.find((c) => c.name === "introductions" && c.type === 0);
const textChannel = introChannel || channels.find((c) => c.type === 0);

if (!textChannel) {
	console.error("No text channel found");
	process.exit(1);
}

console.log(`Using channel: #${textChannel.name} (${textChannel.id})`);
console.log(`Guild ID: ${guild.id}`);

// 3. Create invite
const inviteRes = await fetch(`${API}/channels/${textChannel.id}/invites`, {
	method: "POST",
	headers,
	body: JSON.stringify({
		max_age: 604800, // 7 days
		max_uses: 5,
		unique: true,
	}),
});

const invite = (await inviteRes.json()) as { code: string; expires_at: string };
console.log(`\nDiscord Invite: https://discord.gg/${invite.code}`);
console.log(`Expires: ${invite.expires_at}`);
