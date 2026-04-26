#!/usr/bin/env bun
// 8GI Discord Server Setup - Run by 8CO (Community Officer)
// Creates channels, roles, and welcome message for the 8GI Foundation Discord

import { readFileSync } from "node:fs";

// Load .env
const envFile = readFileSync(`${import.meta.dir}/../.env`, "utf-8");
const env: Record<string, string> = {};
for (const line of envFile.split("\n")) {
	const [key, ...vals] = line.split("=");
	if (key && !key.startsWith("#")) env[key.trim()] = vals.join("=").trim();
}

const TOKEN = env.DISCORD_8CO_BOT_TOKEN;
if (!TOKEN) {
	console.error("Missing DISCORD_8CO_BOT_TOKEN in .env");
	process.exit(1);
}

const API = "https://discord.com/api/v10";
const headers = {
	Authorization: `Bot ${TOKEN}`,
	"Content-Type": "application/json",
};

async function api(method: string, path: string, body?: any) {
	const res = await fetch(`${API}${path}`, {
		method,
		headers,
		body: body ? JSON.stringify(body) : undefined,
	});
	if (!res.ok) {
		const e = await res.text();
		console.error(`${method} ${path}: ${res.status} ${e}`);
		return null;
	}
	return res.status === 204 ? null : res.json();
}

async function main() {
	// Get guilds
	const guilds = await api("GET", "/users/@me/guilds");
	if (!guilds?.length) {
		console.error("Bot not in any servers");
		return;
	}

	const guild = guilds.find((g: any) => g.name.includes("8GI") || g.name.includes("8gi"));
	if (!guild) {
		console.error("8GI server not found");
		return;
	}

	console.log(`Found server: ${guild.name} (${guild.id})`);
	const GUILD = guild.id;

	// Create roles (amber color = 0xD4890C)
	console.log("\nCreating roles...");
	const roles: Record<string, string> = {};

	const roleSpecs = [
		{ name: "Founder", color: 0xd4890c, hoist: true, position: 8 },
		{ name: "Core Circle", color: 0xe8a832, hoist: true, position: 7 },
		{ name: "Circle Member", color: 0xa86b08, hoist: true, position: 6 },
		{ name: "Observer", color: 0x7a6b52, hoist: true, position: 5 },
		{ name: "8gent Officer", color: 0xd4890c, hoist: true, position: 4 },
		{ name: "Board", color: 0xe8a832, hoist: false, position: 3 },
	];

	for (const spec of roleSpecs) {
		const role = await api("POST", `/guilds/${GUILD}/roles`, spec);
		if (role) {
			roles[spec.name] = role.id;
			console.log(`  + ${spec.name} (${role.id})`);
		}
	}

	// Create channel categories and channels
	console.log("\nCreating channels...");

	// Category: WELCOME
	const welcomeCat = await api("POST", `/guilds/${GUILD}/channels`, {
		name: "WELCOME",
		type: 4,
		position: 0,
	});
	if (welcomeCat) {
		await api("POST", `/guilds/${GUILD}/channels`, {
			name: "constitution",
			type: 0,
			parent_id: welcomeCat.id,
			topic: "The 10 articles that govern the collective. Read before joining.",
		});
		await api("POST", `/guilds/${GUILD}/channels`, {
			name: "introductions",
			type: 0,
			parent_id: welcomeCat.id,
			topic: "Say hello. Tell us what you build.",
		});
		await api("POST", `/guilds/${GUILD}/channels`, {
			name: "getting-started",
			type: 0,
			parent_id: welcomeCat.id,
			topic: "Setup guides, FAQ, and first steps.",
		});
		console.log("  + WELCOME (constitution, introductions, getting-started)");
	}

	// Category: CIRCLE
	const circleCat = await api("POST", `/guilds/${GUILD}/channels`, {
		name: "CIRCLE",
		type: 4,
		position: 1,
	});
	if (circleCat) {
		await api("POST", `/guilds/${GUILD}/channels`, {
			name: "general",
			type: 0,
			parent_id: circleCat.id,
			topic: "Circle member discussion. Ship talk only.",
		});
		await api("POST", `/guilds/${GUILD}/channels`, {
			name: "show-and-tell",
			type: 0,
			parent_id: circleCat.id,
			topic: "Show what you built. Demos, screenshots, benchmarks.",
		});
		await api("POST", `/guilds/${GUILD}/channels`, {
			name: "code-review",
			type: 0,
			parent_id: circleCat.id,
			topic: "PR discussions, architecture questions, code feedback.",
		});
		await api("POST", `/guilds/${GUILD}/channels`, {
			name: "help",
			type: 0,
			parent_id: circleCat.id,
			topic: "Setup issues, bugs, questions. No question is too basic.",
		});
		console.log("  + CIRCLE (general, show-and-tell, code-review, help)");
	}

	// Category: BOARD
	const boardCat = await api("POST", `/guilds/${GUILD}/channels`, {
		name: "BOARD",
		type: 4,
		position: 2,
	});
	if (boardCat) {
		await api("POST", `/guilds/${GUILD}/channels`, {
			name: "boardroom",
			type: 0,
			parent_id: boardCat.id,
			topic: "Inner circle deliberations. 8 seats.",
		});
		await api("POST", `/guilds/${GUILD}/channels`, {
			name: "resolutions",
			type: 0,
			parent_id: boardCat.id,
			topic: "Board decisions and vote records.",
		});
		await api("POST", `/guilds/${GUILD}/channels`, {
			name: "security-audit",
			type: 0,
			parent_id: boardCat.id,
			topic: "Karen's domain. Audit findings and incident response.",
		});
		console.log("  + BOARD (boardroom, resolutions, security-audit)");
	}

	// Category: FACTORY
	const factoryCat = await api("POST", `/guilds/${GUILD}/channels`, {
		name: "FACTORY",
		type: 4,
		position: 3,
	});
	if (factoryCat) {
		await api("POST", `/guilds/${GUILD}/channels`, {
			name: "factory-output",
			type: 0,
			parent_id: factoryCat.id,
			topic: "Nightly ability generation results.",
		});
		await api("POST", `/guilds/${GUILD}/channels`, {
			name: "benchmarks",
			type: 0,
			parent_id: factoryCat.id,
			topic: "Autoresearch scores and model comparisons.",
		});
		await api("POST", `/guilds/${GUILD}/channels`, {
			name: "prs",
			type: 0,
			parent_id: factoryCat.id,
			topic: "PR notifications and review requests.",
		});
		console.log("  + FACTORY (factory-output, benchmarks, prs)");
	}

	// Category: GAMES
	const gamesCat = await api("POST", `/guilds/${GUILD}/channels`, {
		name: "GAMES",
		type: 4,
		position: 4,
	});
	if (gamesCat) {
		await api("POST", `/guilds/${GUILD}/channels`, {
			name: "dublin",
			type: 0,
			parent_id: gamesCat.id,
			topic: "8gent.games world chat. Dublin is the first city.",
		});
		await api("POST", `/guilds/${GUILD}/channels`, {
			name: "companions",
			type: 0,
			parent_id: gamesCat.id,
			topic: "Companion deck showoff, species discussion, shiny pulls.",
		});
		console.log("  + GAMES (dublin, companions)");
	}

	// Category: VOICE
	const voiceCat = await api("POST", `/guilds/${GUILD}/channels`, {
		name: "VOICE",
		type: 4,
		position: 5,
	});
	if (voiceCat) {
		await api("POST", `/guilds/${GUILD}/channels`, {
			name: "office-hours",
			type: 2,
			parent_id: voiceCat.id,
		});
		await api("POST", `/guilds/${GUILD}/channels`, {
			name: "pair-programming",
			type: 2,
			parent_id: voiceCat.id,
		});
		console.log("  + VOICE (office-hours, pair-programming)");
	}

	// Post welcome message in constitution channel
	console.log("\nPosting welcome message...");
	const channels = await api("GET", `/guilds/${GUILD}/channels`);
	const constitutionChannel = channels?.find((c: any) => c.name === "constitution");

	if (constitutionChannel) {
		await api("POST", `/channels/${constitutionChannel.id}/messages`, {
			content:
				"# 8GI. Constitution\n\nInfinite General Intelligence. A circle of engineers and their AI agents, building open source together.\n\n## The 10 Articles\n\n**1. No Evil.** No agent, no member, no code shall cause deliberate harm, manipulation, or deception.\n**2. No Hate.** No discrimination, no surveillance of individuals, no hateful content.\n**3. No Exploitation.** No content that exploits children. No violations of consent.\n**4. No Weapons.** No malware. No tools of violence.\n**5. No Theft.** No data theft. No intellectual property infringement.\n**6. Privacy is Sacred.** Personal data never leaves your machine without explicit opt-in.\n**7. Open Source by Default.** MIT licensed core. Knowledge compounds when shared.\n**8. Review Before Merge.** All AI-generated code through human review and security gate.\n**9. The 200-Line Discipline.** No single ability exceeds 200 lines. Break it up or justify it.\n**10. Transparency.** Every step logged. Every decision traceable. Every action reviewable.\n\nAgreement to all 10 articles is required for membership. Read them. Understand them. If any feel wrong, say so.\n\n**Full document:** https://8gent.world/constitution",
		});
		console.log("  + Constitution posted");
	}

	// Post in getting-started
	const gettingStarted = channels?.find((c: any) => c.name === "getting-started");
	if (gettingStarted) {
		await api("POST", `/channels/${gettingStarted.id}/messages`, {
			content:
				"# Welcome to the Circle\n\n## How to join\n1. A current member vouches for you\n2. Read and agree to the Constitution (see #constitution)\n3. Run the setup script: `git clone https://github.com/8gent-foundation/8gi-setup && cd 8gi-setup && ./setup.sh`\n4. Your vessel comes online. You are in.\n\n## What you get\n- Local AI coding agent (8gent Code, powered by Ollama)\n- Your own Telegram bot\n- A persistent vessel on Fly.io\n- Citizenship in the 8gent.games world (Dublin)\n- A companion that evolves with your coding\n\n## What you give\n- Pull requests and code review\n- Honest feedback\n- Anonymised usage patterns (opt-in only)\n\n## Links\n- Constitution: https://8gent.world/constitution\n- Source code: https://8gent.dev\n- Games world: https://8gent.games\n- GitHub org: https://github.com/8gent-foundation\n\nThe collective gets smarter every session. That includes yours.",
		});
		console.log("  + Getting started guide posted");
	}

	console.log("\n8GI Discord setup complete.");
	console.log(`Server: ${guild.name}`);
	console.log(`Roles: ${Object.keys(roles).join(", ")}`);
	console.log("Channels: 6 categories, 16 channels");
}

main().catch(console.error);
