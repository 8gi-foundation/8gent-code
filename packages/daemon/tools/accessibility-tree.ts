/**
 * AppKit-based accessibility tree query.
 *
 * Replaces the Phase 1 stub in `hands.ts` with a real native AX tree.
 * Implementation strategy: shell out to a tiny Swift CLI helper
 * (`accessibility-tree-cli`, source at
 * `apps/8gent-computer/Sources/AccessibilityTreeCLI/main.swift`) that
 * calls `AXUIElementCopyAttributeValue` and friends, then prints a
 * structured JSON tree on stdout.
 *
 * Why a CLI rather than FFI: AX requires accessibility permission (TCC
 * prompts the user once). The CLI is a self-contained signed binary
 * that ships with the 8gent Computer app bundle; permission lives on
 * the binary, not on the daemon. This avoids the bigger daemon needing
 * a TCC entry of its own.
 *
 * Lookup order for the binary (first hit wins):
 *   1. EIGHT_AX_CLI env var (absolute path)
 *   2. $HOME/.8gent/bin/accessibility-tree-cli
 *   3. apps/8gent-computer/.build/release/accessibility-tree-cli (dev)
 *
 * If no binary is found we return an `unavailable` payload so the cua
 * loop's tree-first perception escalates to a screenshot rather than
 * exploding. The NemoClaw policy gate stays in place either way.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface AccessibilityTreeNode {
	role: string;
	title?: string;
	value?: string;
	position?: { x: number; y: number };
	size?: { width: number; height: number };
	enabled?: boolean;
	focused?: boolean;
	clickable?: boolean;
	children?: AccessibilityTreeNode[];
}

export type AccessibilityTreeResult =
	| {
			ok: true;
			pid: number;
			appName?: string;
			windowTitle?: string;
			root: AccessibilityTreeNode;
			tokens: number;
			source: "appkit-cli";
	  }
	| {
			ok: false;
			error: string;
			source: "appkit-cli" | "unavailable" | "platform";
	  };

const REPO_ROOT = resolve(__dirname, "..", "..", "..");

const CANDIDATE_PATHS = [
	process.env.EIGHT_AX_CLI,
	join(homedir(), ".8gent", "bin", "accessibility-tree-cli"),
	join(REPO_ROOT, "apps", "8gent-computer", ".build", "release", "accessibility-tree-cli"),
	join(REPO_ROOT, "apps", "8gent-computer", ".build", "debug", "accessibility-tree-cli"),
].filter(Boolean) as string[];

function locateBinary(): string | undefined {
	for (const p of CANDIDATE_PATHS) {
		if (existsSync(p)) return p;
	}
	return undefined;
}

const SPAWN_TIMEOUT_MS = 5_000;

function estimateTokens(text: string): number {
	// Rough heuristic: ~4 chars per JSON token. The cua loop uses this to
	// budget perception calls.
	return Math.ceil(text.length / 4);
}

interface RawCliOutput {
	ok: boolean;
	pid?: number;
	appName?: string | null;
	windowTitle?: string | null;
	root?: AccessibilityTreeNode;
	error?: string;
}

async function runCli(args: string[]): Promise<{ stdout: string; code: number; stderr: string }> {
	const binary = locateBinary();
	if (!binary) {
		return { stdout: "", code: -1, stderr: "binary not found" };
	}
	return new Promise((resolveProm) => {
		const child = spawn(binary, ["--json-only", ...args], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			stderr += "\n[ax-cli] killed: timeout";
		}, SPAWN_TIMEOUT_MS);
		child.stdout.on("data", (d) => {
			stdout += d.toString();
		});
		child.stderr.on("data", (d) => {
			stderr += d.toString();
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolveProm({ stdout, code: code ?? -1, stderr });
		});
		child.on("error", (err) => {
			clearTimeout(timer);
			stderr += `\n[ax-cli] spawn error: ${err.message}`;
			resolveProm({ stdout, code: -1, stderr });
		});
	});
}

export interface QueryAccessibilityTreeInput {
	/** Specific PID to query. Default: focused window. */
	pid?: number;
}

export async function queryAccessibilityTree(
	input: QueryAccessibilityTreeInput = {},
): Promise<AccessibilityTreeResult> {
	if (process.platform !== "darwin") {
		return {
			ok: false,
			error: "accessibility tree is macOS-only",
			source: "platform",
		};
	}

	const binary = locateBinary();
	if (!binary) {
		return {
			ok: false,
			error:
				"accessibility-tree-cli not built. Run `cd apps/8gent-computer && swift build -c release` " +
				"or set EIGHT_AX_CLI to an absolute path.",
			source: "unavailable",
		};
	}

	const cliArgs: string[] = [];
	if (input.pid !== undefined) cliArgs.push("--pid", String(input.pid));

	const { stdout, code, stderr } = await runCli(cliArgs);
	if (code !== 0 && !stdout) {
		return {
			ok: false,
			error: `appkit-cli exit ${code}: ${stderr.trim() || "no output"}`,
			source: "appkit-cli",
		};
	}

	let parsed: RawCliOutput;
	try {
		parsed = JSON.parse(stdout.trim());
	} catch (err) {
		return {
			ok: false,
			error: `failed to parse ax-cli output: ${(err as Error).message}`,
			source: "appkit-cli",
		};
	}

	if (!parsed.ok || !parsed.root) {
		return {
			ok: false,
			error: parsed.error ?? "ax-cli returned ok=false with no error",
			source: "appkit-cli",
		};
	}

	return {
		ok: true,
		pid: parsed.pid ?? input.pid ?? 0,
		appName: parsed.appName ?? undefined,
		windowTitle: parsed.windowTitle ?? undefined,
		root: parsed.root,
		tokens: estimateTokens(stdout),
		source: "appkit-cli",
	};
}

/**
 * Pure helper exported for `hands.ts` to drop the daemon-side stub.
 * The dispatcher still wraps this in NemoClaw policy via the existing
 * `evaluatePolicy("desktop_use", ...)` call.
 */
export async function dispatchAccessibilityTree(input: Record<string, unknown>): Promise<unknown> {
	const pid = input.pid !== undefined ? Number(input.pid) : undefined;
	const out = await queryAccessibilityTree({ pid });
	return out;
}
