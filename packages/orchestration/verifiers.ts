/**
 * verifiers.ts - real, pluggable quality gates that feed the adaptive pipeline's
 * existing Obstacle -> Severity -> Decision machinery.
 *
 * Each Verifier answers one honest question about a unit of work: does the file
 * exist, does it compile, does the server respond. A failing verifier returns a
 * VerifierFinding with ok=false, which the pipeline maps into an Obstacle and
 * acts on via its Severity logic. This is how the loop learns that a unit
 * ACTUALLY works instead of trusting model prose.
 */

import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { join, isAbsolute } from "node:path";

import type {
	Verifier,
	VerifierFinding,
	VerifierSeverity,
	VerifyInput,
} from "./pipeline-contracts.js";

/** Resolve a unit path against the working directory unless it is already absolute. */
function resolvePath(workingDirectory: string, path: string): string {
	return isAbsolute(path) ? path : join(workingDirectory, path);
}

/** True iff `absPath` is an existing, non-empty regular file. */
function isNonEmptyFile(absPath: string): boolean {
	try {
		const st = statSync(absPath);
		return st.isFile() && st.size > 0;
	} catch {
		return false;
	}
}

/**
 * fileExistsVerifier - the unit's target file must exist on disk and be
 * non-empty. A missing or empty file is a severe obstacle: the unit produced
 * nothing real.
 */
export const fileExistsVerifier: Verifier = {
	name: "file-exists",
	async verify(input: VerifyInput): Promise<VerifierFinding> {
		const rel = input.unit?.path;
		if (!rel) {
			// No unit/path to check -> nothing to fail on.
			return {
				ok: true,
				severity: "trivial",
				type: "no-file",
				detail: "no unit path provided",
			};
		}
		const abs = resolvePath(input.workingDirectory, rel);
		if (isNonEmptyFile(abs)) {
			return { ok: true, severity: "trivial", type: "file-exists", detail: rel };
		}
		return {
			ok: false,
			severity: "severe",
			type: "missing-file",
			detail: `expected non-empty file at ${rel}`,
		};
	},
};

/**
 * tscVerifier - run a TypeScript no-emit type-check in the working directory.
 * Exit 0 is a pass; a non-zero exit is a severe compile-error; a timeout is a
 * moderate compile-timeout; and a project without tsc/tsconfig is trivially ok
 * (we do not fail a non-TS project for lacking TypeScript).
 */
export const tscVerifier: Verifier = {
	name: "tsc-noemit",
	async verify(input: VerifyInput): Promise<VerifierFinding> {
		const TIMEOUT_MS = 60_000;
		return await new Promise<VerifierFinding>((resolve) => {
			let stdout = "";
			let stderr = "";
			let settled = false;
			let timer: ReturnType<typeof setTimeout> | undefined;

			const finish = (finding: VerifierFinding): void => {
				if (settled) return;
				settled = true;
				if (timer) clearTimeout(timer);
				resolve(finding);
			};

			let child: ReturnType<typeof spawn>;
			try {
				child = spawn("bunx", ["tsc", "--noEmit"], {
					cwd: input.workingDirectory,
					stdio: ["ignore", "pipe", "pipe"],
				});
			} catch {
				// Could not even launch tsc -> treat as no-tsconfig (don't punish).
				finish({
					ok: true,
					severity: "trivial",
					type: "no-tsconfig",
					detail: "tsc unavailable",
				});
				return;
			}

			timer = setTimeout(() => {
				try {
					child.kill("SIGKILL");
				} catch {
					/* already gone */
				}
				finish({
					ok: false,
					severity: "moderate",
					type: "compile-timeout",
					detail: `tsc --noEmit exceeded ${TIMEOUT_MS}ms`,
				});
			}, TIMEOUT_MS);

			child.stdout?.on("data", (d: Buffer) => {
				stdout += d.toString();
			});
			child.stderr?.on("data", (d: Buffer) => {
				stderr += d.toString();
			});

			child.on("error", () => {
				// Spawn-time failure (binary missing): don't fail a non-TS project.
				finish({
					ok: true,
					severity: "trivial",
					type: "no-tsconfig",
					detail: "tsc unavailable",
				});
			});

			child.on("close", (code: number | null) => {
				const out = (stdout + stderr).trim();
				// tsc reports a missing tsconfig as an error; treat that as no-tsconfig.
				if (/TS5(?:057|058)|Cannot find a tsconfig|No inputs were found/i.test(out)) {
					finish({
						ok: true,
						severity: "trivial",
						type: "no-tsconfig",
						detail: "no tsconfig.json found",
					});
					return;
				}
				if (code === 0) {
					finish({ ok: true, severity: "trivial", type: "tsc-clean", detail: "no type errors" });
					return;
				}
				finish({
					ok: false,
					severity: "severe",
					type: "compile-error",
					detail: out.slice(0, 200) || `tsc exited ${code}`,
				});
			});
		});
	},
};

/**
 * httpVerifier - if a dev/preview URL is provided, the server must answer with a
 * 2xx. A non-2xx or a fetch failure is a severe http-error. No URL is trivially
 * ok (nothing to reach).
 */
export const httpVerifier: Verifier = {
	name: "http-reachable",
	async verify(input: VerifyInput): Promise<VerifierFinding> {
		const url = input.url;
		if (!url) {
			return { ok: true, severity: "trivial", type: "no-url", detail: "no url to check" };
		}
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 5_000);
		try {
			const res = await fetch(url, { signal: controller.signal });
			if (res.status >= 200 && res.status < 300) {
				return { ok: true, severity: "trivial", type: "http-ok", detail: `${res.status} ${url}` };
			}
			return {
				ok: false,
				severity: "severe",
				type: "http-error",
				detail: `${res.status} from ${url}`,
			};
		} catch (err) {
			return {
				ok: false,
				severity: "severe",
				type: "http-error",
				detail: `fetch failed for ${url}: ${(err as Error).message}`,
			};
		} finally {
			clearTimeout(timer);
		}
	},
};

/**
 * makeFilesWrittenVerifier - the honesty check. Given the paths a node CLAIMS it
 * wrote, every one must exist and be non-empty on disk. Any phantom write is a
 * severe missing-file obstacle.
 */
export function makeFilesWrittenVerifier(paths: string[]): Verifier {
	return {
		name: "files-written",
		async verify(input: VerifyInput): Promise<VerifierFinding> {
			const missing: string[] = [];
			for (const p of paths) {
				const abs = resolvePath(input.workingDirectory, p);
				if (!isNonEmptyFile(abs)) missing.push(p);
			}
			if (missing.length === 0) {
				return {
					ok: true,
					severity: "trivial",
					type: "files-written",
					detail: `${paths.length} file(s) verified on disk`,
				};
			}
			return {
				ok: false,
				severity: "severe",
				type: "missing-file",
				detail: `claimed but missing/empty: ${missing.join(", ")}`,
			};
		},
	};
}

/**
 * verifierFindingToObstacle - the seam the pipeline uses to map a finding into
 * its own ObstacleType/Severity enums. Pass through type + severity verbatim.
 */
export function verifierFindingToObstacle(f: VerifierFinding): {
	type: string;
	severity: VerifierSeverity;
} {
	return { type: f.type, severity: f.severity };
}

/**
 * runVerifiers - run a list of verifiers against one input and collect every
 * finding. Sequential is fine: verifiers are cheap relative to the agent loop,
 * and ordering keeps logs deterministic.
 */
export async function runVerifiers(
	verifiers: Verifier[],
	input: VerifyInput,
): Promise<VerifierFinding[]> {
	const findings: VerifierFinding[] = [];
	for (const v of verifiers) {
		findings.push(await v.verify(input));
	}
	return findings;
}
