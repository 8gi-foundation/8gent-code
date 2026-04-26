#!/usr/bin/env bun
/**
 * Host CLI Mesh Hook
 *
 * Auto-registers host CLI sessions with the Agent Mesh.
 * Install as a host CLI hook to enable inter-session communication.
 *
 * Usage (host CLI settings.json):
 * {
 *   "hooks": {
 *     "SessionStart": [{
 *       "command": "bun run ~/8gent-code/packages/orchestration/mesh-hook.ts register"
 *     }],
 *     "SessionEnd": [{
 *       "command": "bun run ~/8gent-code/packages/orchestration/mesh-hook.ts deregister"
 *     }]
 *   }
 * }
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AgentMesh, joinMesh } from "./agent-mesh";

const STATE_DIR = join(homedir(), ".8gent", "mesh");
const MY_STATE = join(STATE_DIR, `hook-${process.ppid}.json`);

const command = process.argv[2] || "register";

if (command === "register") {
	// Register this host CLI session
	const mesh = joinMesh({
		type: "host-cli-primary",
		name: `host-cli-${process.ppid}`,
		capabilities: ["code", "edit", "bash", "search"],
		channel: "terminal",
	});

	// Save our mesh ID for deregister
	mkdirSync(STATE_DIR, { recursive: true });
	writeFileSync(
		MY_STATE,
		JSON.stringify({ agentId: mesh.agentId, pid: process.ppid }),
	);

	// Announce arrival
	mesh.broadcast("event", `Host CLI session started in ${process.cwd()}`);

	console.log(`[mesh-hook] Registered as ${mesh.agentId}`);
} else if (command === "deregister") {
	// Read our state and clean up
	if (existsSync(MY_STATE)) {
		try {
			const state = JSON.parse(readFileSync(MY_STATE, "utf-8"));
			// Read registry and remove ourselves
			const registryPath = join(STATE_DIR, "registry.json");
			if (existsSync(registryPath)) {
				const registry = JSON.parse(readFileSync(registryPath, "utf-8"));
				if (registry[state.agentId]) {
					delete registry[state.agentId];
					writeFileSync(registryPath, JSON.stringify(registry, null, 2));
				}
			}
			// Clean up state file
			const { unlinkSync } = require("node:fs");
			unlinkSync(MY_STATE);
			console.log(`[mesh-hook] Deregistered ${state.agentId}`);
		} catch {}
	}
} else if (command === "status") {
	// Show mesh status
	const registryPath = join(STATE_DIR, "registry.json");
	if (existsSync(registryPath)) {
		const registry = JSON.parse(readFileSync(registryPath, "utf-8"));
		const agents = Object.values(registry) as any[];
		console.log(`\nAgent Mesh: ${agents.length} agents online\n`);
		for (const a of agents) {
			const age = Math.round((Date.now() - a.startedAt) / 1000);
			const stale = Date.now() - a.lastHeartbeat > 60000 ? " (stale)" : "";
			console.log(
				`  ${a.type}/${a.name} [${a.capabilities.join(",")}] - ${a.cwd} (${age}s)${stale}`,
			);
		}
	} else {
		console.log("No mesh registry found");
	}
}
