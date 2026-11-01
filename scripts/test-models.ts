#!/usr/bin/env bun
/**
 * test-models — smoke each provider+model wired into the role registry.
 *
 * Usage:
 *   bun scripts/test-models.ts                  # test every role
 *   bun scripts/test-models.ts orchestrator     # test a single role
 *   bun scripts/test-models.ts --providers      # also run a per-provider probe
 *
 * Prints a table: role, provider, model, status (OK / FAIL), latency, error.
 * Exits non-zero if any role fails so CI can block bad role-registry edits.
 */

import { createModel, type ProviderName } from "../packages/ai/providers";
import { ROLE_REGISTRY } from "../packages/orchestration/role-registry";
import { probeProviders } from "../apps/tui/src/lib/provider-health";
import { generateText } from "ai";

interface RoleResult {
	role: string;
	provider: string;
	model: string;
	ok: boolean;
	durationMs: number;
	textPreview?: string;
	error?: string;
}

async function testRole(role: string): Promise<RoleResult> {
	const cfg = ROLE_REGISTRY[role];
	const start = performance.now();
	if (!cfg) {
		return {
			role,
			provider: "?",
			model: "?",
			ok: false,
			durationMs: 0,
			error: `role not in ROLE_REGISTRY`,
		};
	}
	if (!cfg.inferenceMode || !cfg.model) {
		return {
			role,
			provider: cfg.inferenceMode ?? "?",
			model: cfg.model ?? "?",
			ok: false,
			durationMs: 0,
			error: `role has no inferenceMode/model assigned`,
		};
	}

	try {
		const model = createModel({ name: cfg.inferenceMode as ProviderName, model: cfg.model });
		const result = await generateText({
			model,
			messages: [{ role: "user", content: "say only the word: ok" }],
		});
		const ms = Math.round(performance.now() - start);
		return {
			role,
			provider: cfg.inferenceMode,
			model: cfg.model,
			ok: true,
			durationMs: ms,
			textPreview: result.text.slice(0, 60).replace(/\n/g, " "),
		};
	} catch (err) {
		const ms = Math.round(performance.now() - start);
		return {
			role,
			provider: cfg.inferenceMode,
			model: cfg.model,
			ok: false,
			durationMs: ms,
			error: (err as Error).message?.slice(0, 200) ?? String(err),
		};
	}
}

function printTable(results: RoleResult[]): void {
	const widths = {
		role: Math.max(4, ...results.map((r) => r.role.length)),
		provider: Math.max(8, ...results.map((r) => r.provider.length)),
		model: Math.max(5, ...results.map((r) => r.model.length)),
	};
	const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - s.length));

	console.log(
		[
			pad("role", widths.role),
			pad("provider", widths.provider),
			pad("model", widths.model),
			"status",
			"ms",
			"detail",
		].join("  "),
	);
	console.log("-".repeat(80));
	for (const r of results) {
		const status = r.ok ? "OK  " : "FAIL";
		const detail = r.ok ? r.textPreview ?? "" : r.error ?? "";
		console.log(
			[
				pad(r.role, widths.role),
				pad(r.provider, widths.provider),
				pad(r.model, widths.model),
				status,
				String(r.durationMs).padStart(5),
				detail.slice(0, 60),
			].join("  "),
		);
	}
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const showProviders = args.includes("--providers");
	const targets = args.filter((a) => !a.startsWith("--"));

	if (showProviders) {
		console.log("\n=== provider health ===");
		const probe = await probeProviders();
		console.log(`live: ${probe.live}/${probe.total}`);
		for (const s of probe.statuses) {
			console.log(`  ${s.live ? "✓" : "✗"} ${s.name}`);
		}
	}

	const roles = targets.length ? targets : Object.keys(ROLE_REGISTRY);
	console.log(`\n=== role smoke (${roles.length} role${roles.length === 1 ? "" : "s"}) ===`);
	const results: RoleResult[] = [];
	for (const role of roles) {
		process.stdout.write(`testing ${role}...`);
		const r = await testRole(role);
		process.stdout.write(r.ok ? " OK\n" : " FAIL\n");
		results.push(r);
	}

	console.log("");
	printTable(results);

	const fails = results.filter((r) => !r.ok);
	if (fails.length > 0) {
		console.log(`\n${fails.length}/${results.length} failed`);
		process.exit(1);
	}
	console.log(`\nall ${results.length} passed`);
}

await main();
