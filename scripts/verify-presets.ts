#!/usr/bin/env bun
/**
 * verify-presets — end-to-end matrix test for every external-agent
 * preset. Catches the "I made up the install path / made up the
 * prompt flag" class of bug before it ships.
 *
 * For each preset:
 *   1. Check the binary is on PATH (skip with reason if not).
 *   2. Round-trip through the actual runExternalAgent flow with a
 *      tiny "reply pong" prompt and a per-preset timeout.
 *   3. Report status (OK / ERR / SKIP) and the first 100 chars of
 *      output or error.
 *
 * Exit code:
 *   0 — every preset whose binary IS installed responded OK
 *   1 — at least one installed preset failed (test broke)
 *
 * Skipped presets (binary not installed) do NOT fail the run — that's
 * a CI-friendly default. Pass `--strict` to require every preset's
 * binary to be present.
 *
 * Run:  bun scripts/verify-presets.ts
 *       bun scripts/verify-presets.ts --strict
 */

import {
	getPreset,
	isInstalled,
	listPresetIds,
	runExternalAgent,
} from "../apps/tui/src/lib/external-agent-runner.js";

const TEST_PROMPT = "reply with the single word: pong";
// 8gent run can take 30-60s on cold Ollama load. Other presets reply
// in seconds when their auth is configured.
const PER_PRESET_TIMEOUT_MS = 90_000;

interface RowResult {
	id: string;
	command: string;
	status: "OK" | "ERR" | "SKIP";
	detail: string;
}

function strict(): boolean {
	return process.argv.includes("--strict");
}

async function main() {
	const ids = listPresetIds();
	const rows: RowResult[] = [];

	console.log(
		`\nVerifying ${ids.length} external-agent presets via runExternalAgent.\n`,
	);

	for (const id of ids) {
		const preset = getPreset(id);
		if (!preset) {
			rows.push({ id, command: "?", status: "ERR", detail: "preset not found" });
			continue;
		}

		if (!isInstalled(preset)) {
			rows.push({
				id,
				command: preset.command,
				status: "SKIP",
				detail: "binary not on $PATH (run /spawn install or skip)",
			});
			continue;
		}

		try {
			const result = await Promise.race([
				runExternalAgent(preset, TEST_PROMPT),
				new Promise<{ ok: false; text: string; error: string }>((res) =>
					setTimeout(
						() =>
							res({
								ok: false,
								text: "",
								error: `verify-presets timeout after ${PER_PRESET_TIMEOUT_MS / 1000}s`,
							}),
						PER_PRESET_TIMEOUT_MS,
					),
				),
			]);
			const detail = (result.text || result.error || "")
				.replace(/\s+/g, " ")
				.slice(0, 100);
			rows.push({
				id,
				command: preset.command,
				status: result.ok ? "OK" : "ERR",
				detail,
			});
		} catch (err) {
			rows.push({
				id,
				command: preset.command,
				status: "ERR",
				detail: err instanceof Error ? err.message.slice(0, 100) : "unknown error",
			});
		}
	}

	// Report
	const idWidth = Math.max(...rows.map((r) => r.id.length));
	const cmdWidth = Math.max(...rows.map((r) => r.command.length));
	for (const r of rows) {
		const icon = r.status === "OK" ? "✓" : r.status === "SKIP" ? "·" : "✗";
		console.log(
			`  ${icon} ${r.id.padEnd(idWidth)}  ${r.command.padEnd(cmdWidth)}  ${r.status.padEnd(4)}  ${r.detail}`,
		);
	}

	// Summary
	const ok = rows.filter((r) => r.status === "OK").length;
	const err = rows.filter((r) => r.status === "ERR").length;
	const skip = rows.filter((r) => r.status === "SKIP").length;
	console.log(`\n  ${ok} OK · ${err} ERR · ${skip} SKIP\n`);

	const failed = err > 0 || (strict() && skip > 0);
	if (failed) {
		console.error(
			strict()
				? "FAIL: at least one preset errored or was skipped (--strict)."
				: "FAIL: at least one preset errored. Run with binaries installed to debug.",
		);
		process.exit(1);
	}
	process.exit(0);
}

void main();
