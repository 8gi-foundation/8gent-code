/**
 * harness-cli: doctor command
 *
 * Health-check: verifies providers are available and tools are loadable.
 *
 * With EIGHT_DOCTOR_TIERS=1 (off by default, #3451) each check also carries a
 * tier (how bad a failure is), the layer it tests, and a one-line fix, and the
 * report is grouped critical first. With the flag off the output is unchanged,
 * pinned by __fixtures__/doctor-flag-off.json. Tiered mode adds no checks,
 * makes no extra calls and prints no part of a credential.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type CheckName =
	| "Sessions directory"
	| "Existing sessions"
	| "Ollama"
	| "LM Studio"
	| "OpenRouter API key"
	| "Agent module"
	| "AI SDK tools";

export type Tier = "critical" | "structural" | "hygiene";
export type Layer = "sessions" | "providers" | "credentials" | "runtime" | "tools";

export const TIER_ORDER: readonly Tier[] = ["critical", "structural", "hygiene"];

/** Tier, layer and copy-paste fix for every existing check. No new checks. */
export const CHECK_META: Record<CheckName, { tier: Tier; layer: Layer; fix: string }> = {
	"Sessions directory": {
		tier: "structural",
		layer: "sessions",
		fix: "mkdir -p ~/.8gent/sessions",
	},
	"Existing sessions": {
		tier: "hygiene",
		layer: "sessions",
		fix: "8gent   # run one session to record a file",
	},
	Ollama: { tier: "critical", layer: "providers", fix: "ollama serve" },
	"LM Studio": {
		tier: "hygiene",
		layer: "providers",
		fix: "lms server start   # optional, only if you use LM Studio",
	},
	"OpenRouter API key": {
		tier: "hygiene",
		layer: "credentials",
		fix: "export OPENROUTER_API_KEY=<your-key>   # optional cloud failover",
	},
	"Agent module": {
		tier: "critical",
		layer: "runtime",
		fix: "bun install   # from the 8gent-code checkout",
	},
	"AI SDK tools": {
		tier: "critical",
		layer: "tools",
		fix: "bun install   # from the 8gent-code checkout",
	},
};

export type Check = { name: CheckName; pass: boolean; detail: string };

/** Seams for tests. Every default is what the command used before #3451. */
export interface DoctorDeps {
	home?: string;
	env?: Record<string, string | undefined>;
	fetch?: (url: string, init?: RequestInit) => Promise<Response>;
	loadAgent?: () => Promise<unknown>;
	loadTools?: () => Promise<{ agentTools: Record<string, unknown> }>;
}

export async function doctor(_args: string[], deps: DoctorDeps = {}): Promise<void> {
	const env = deps.env ?? process.env;
	const tiers = env.EIGHT_DOCTOR_TIERS === "1";
	const fetch = deps.fetch ?? globalThis.fetch;
	const SESSIONS_DIR = path.join(deps.home ?? os.homedir(), ".8gent", "sessions");

	console.log("\n  8gent Harness — Health Check\n");

	const checks: Check[] = [];

	// 1. Sessions directory
	const sessionsExist = fs.existsSync(SESSIONS_DIR);
	checks.push({
		name: "Sessions directory",
		pass: sessionsExist,
		detail: sessionsExist ? SESSIONS_DIR : `${SESSIONS_DIR} does not exist`,
	});

	// 2. Session count
	if (sessionsExist) {
		const count = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith(".jsonl")).length;
		checks.push({
			name: "Existing sessions",
			pass: true,
			detail: `${count} session file(s)`,
		});
	}

	// 3. Check Ollama
	try {
		const resp = await fetch("http://localhost:11434/api/tags", {
			signal: AbortSignal.timeout(3000),
		});
		if (resp.ok) {
			const data = (await resp.json()) as any;
			const models = (data.models ?? []).map((m: any) => m.name).slice(0, 5);
			checks.push({
				name: "Ollama",
				pass: true,
				detail: `Running, models: ${models.join(", ") || "none"}`,
			});
		} else {
			checks.push({
				name: "Ollama",
				pass: false,
				detail: `HTTP ${resp.status}`,
			});
		}
	} catch {
		checks.push({
			name: "Ollama",
			pass: false,
			detail: "Not running (localhost:11434)",
		});
	}

	// 4. Check LM Studio
	try {
		const resp = await fetch("http://localhost:1234/v1/models", {
			signal: AbortSignal.timeout(3000),
		});
		if (resp.ok) {
			checks.push({
				name: "LM Studio",
				pass: true,
				detail: "Running on :1234",
			});
		} else {
			checks.push({
				name: "LM Studio",
				pass: false,
				detail: `HTTP ${resp.status}`,
			});
		}
	} catch {
		checks.push({
			name: "LM Studio",
			pass: false,
			detail: "Not running (localhost:1234)",
		});
	}

	// 5. OpenRouter API key
	const orKey = env.OPENROUTER_API_KEY;
	checks.push({
		name: "OpenRouter API key",
		pass: !!orKey,
		detail: orKey
			? tiers
				? "Set"
				: `Set (${orKey.slice(0, 8)}...)`
			: "Not set (OPENROUTER_API_KEY)",
	});

	// 6. Agent module loadable
	try {
		await (deps.loadAgent ?? (() => import("../../eight/agent.js")))();
		checks.push({
			name: "Agent module",
			pass: true,
			detail: "packages/eight/agent.ts loaded",
		});
	} catch (err) {
		checks.push({
			name: "Agent module",
			pass: false,
			detail: `Failed to import: ${err instanceof Error ? err.message : String(err)}`,
		});
	}

	// 7. AI SDK tools loadable
	try {
		const { agentTools } = await (deps.loadTools ?? (() => import("../../ai/tools.js")))();
		const toolCount = Object.keys(agentTools).length;
		checks.push({
			name: "AI SDK tools",
			pass: true,
			detail: `${toolCount} tools registered`,
		});
	} catch (err) {
		checks.push({
			name: "AI SDK tools",
			pass: false,
			detail: `Failed to import: ${err instanceof Error ? err.message : String(err)}`,
		});
	}

	if (tiers) {
		printTiered(checks);
		return;
	}

	// Print results
	let allPass = true;
	for (const check of checks) {
		const icon = check.pass ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
		console.log(`  ${icon} ${check.name.padEnd(22)} ${check.detail}`);
		if (!check.pass) allPass = false;
	}

	console.log();
	if (allPass) {
		console.log("  \x1b[32mAll checks passed.\x1b[0m\n");
	} else {
		console.log("  \x1b[33mSome checks failed — 8gent may not work fully.\x1b[0m\n");
	}
}

/** Tiered report: groups critical first, the layer on each line, the fix under each failure. */
export function printTiered(checks: Check[]): void {
	const failing: Record<Tier, number> = { critical: 0, structural: 0, hygiene: 0 };
	for (const tier of TIER_ORDER) {
		const group = checks.filter((c) => CHECK_META[c.name].tier === tier);
		if (group.length === 0) continue;
		console.log(`  ${tier.toUpperCase()}`);
		for (const check of group) {
			const { layer, fix } = CHECK_META[check.name];
			const icon = check.pass ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
			console.log(`  ${icon} ${check.name.padEnd(22)} [${layer}] ${check.detail}`);
			if (!check.pass) {
				failing[tier]++;
				console.log(`      fix: ${fix}`);
			}
		}
		console.log();
	}
	const total = failing.critical + failing.structural + failing.hygiene;
	if (total === 0) {
		console.log("  \x1b[32mAll checks passed.\x1b[0m\n");
	} else {
		console.log(
			`  \x1b[33m${total} failing: ${failing.critical} critical, ${failing.structural} structural, ${failing.hygiene} hygiene. Fix critical first.\x1b[0m\n`,
		);
	}
}
