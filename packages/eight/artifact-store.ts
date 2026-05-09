/**
 * 8gent Code - Artifact Store
 *
 * Persists tool results above a size threshold to disk and hands the model
 * a short reference chip instead of the full payload. Sub-agents (or the
 * CLI) re-fetch via `read(hash)`. Issue #2463.
 *
 * Concept extracted from StartupHakk/OpenMonoAgent under CleanRoomPort
 * rules; no AGPL source copied. Behaviour rebuilt from the issue spec
 * and the 8DO chip-format amendment (2026-05-09 boardroom).
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
// Import validatePath directly from the path-guard module rather than the
// permissions barrel. The barrel pulls in policy-engine which transitively
// depends on `yaml`; for a tool-result hot path we want zero extra deps.
import { validatePath } from "../permissions/path-guard";

// ---- Public types --------------------------------------------------------

export interface PersistOptions {
	/** When true the result is treated as a tool error and never persisted. */
	isError?: boolean;
}

// ---- Constants -----------------------------------------------------------

const DEFAULT_THRESHOLD = 50_000;
const HASH_PREFIX_LEN = 8; // 8 hex chars = 32 bits, ample for per-session uniqueness
const PREVIEW_BYTES = 1024;

// ---- Helpers -------------------------------------------------------------

function defaultDataDir(): string {
	return path.join(os.homedir(), ".8gent", "artifacts");
}

function thresholdFromEnv(fallback: number): number {
	const raw = process.env.ARTIFACT_THRESHOLD;
	if (!raw) return fallback;
	const n = Number.parseInt(raw, 10);
	return Number.isFinite(n) && n > 0 ? n : fallback;
}

function formatSize(bytes: number): string {
	if (bytes >= 1024 * 1024) {
		const mb = bytes / (1024 * 1024);
		// Whole-MB renders as "1MB", fractional as "1.3MB".
		return mb % 1 === 0 ? `${mb}MB` : `${mb.toFixed(1)}MB`;
	}
	const kb = bytes / 1024;
	return kb % 1 === 0 ? `${kb}KB` : `${kb.toFixed(1)}KB`;
}

function sha256Hex(input: string): string {
	return createHash("sha256").update(input, "utf8").digest("hex");
}

function ensureDirAllowed(dir: string): void {
	// Run PathGuard on the write-path. 8SO concern: the policy engine guards
	// reads via the agent loop, but the artifact store writes from the tool
	// boundary. A symlink under the data dir pointing into ~/.ssh would
	// otherwise let a malicious tool result land on a credential file.
	const result = validatePath(dir, process.cwd());
	if (!result.ok) {
		throw new Error(`[artifact-store] PathGuard denied dataDir: ${result.reason}`);
	}
}

// ---- Public API ----------------------------------------------------------

export class ArtifactStore {
	readonly sessionId: string;
	readonly threshold: number;
	private readonly sessionDir: string;
	private readonly hashes: Set<string> = new Set();

	constructor(sessionId: string, dataDir?: string, threshold?: number) {
		this.sessionId = sessionId;
		this.threshold = thresholdFromEnv(threshold ?? DEFAULT_THRESHOLD);
		const root = dataDir ?? defaultDataDir();
		this.sessionDir = path.join(root, sessionId);
		// Validate the parent root through PathGuard before we touch the FS.
		// We check `root` (not `sessionDir`) because the sessionId is our own
		// trusted input and PathGuard expects an existing-or-resolvable path.
		ensureDirAllowed(root);
	}

	/** Number of artifacts persisted in this session. */
	get size(): number {
		return this.hashes.size;
	}

	/**
	 * Persist `result` to disk if it exceeds the threshold and replace it
	 * with a chip + preview. Returns the original string untouched if it is
	 * below the threshold or if `options.isError` is set.
	 */
	persistAndReplace(result: string, _toolName: string, options: PersistOptions = {}): string {
		if (options.isError) return result;
		if (typeof result !== "string") return result;
		const byteLen = Buffer.byteLength(result, "utf8");
		if (byteLen <= this.threshold) return result;

		const fullHash = sha256Hex(result);
		const hash = fullHash.slice(0, HASH_PREFIX_LEN);
		const filePath = path.join(this.sessionDir, `${hash}.txt`);

		// Idempotent: if the file already exists with this hash, skip the write.
		if (!this.hashes.has(hash) && !fs.existsSync(filePath)) {
			fs.mkdirSync(this.sessionDir, { recursive: true });
			// `wx` flag fails if another concurrent persist beat us to it; we
			// then treat that as a successful idempotent write.
			try {
				fs.writeFileSync(filePath, result, { encoding: "utf8", flag: "wx" });
			} catch (err: unknown) {
				const code = (err as NodeJS.ErrnoException).code;
				if (code !== "EEXIST") throw err;
			}
		}
		this.hashes.add(hash);

		return this.renderChip(hash, byteLen, result, filePath);
	}

	/** Re-fetch the full original content for a previously persisted hash. */
	async read(hash: string): Promise<string> {
		const filePath = path.join(this.sessionDir, `${hash}.txt`);
		try {
			return await fs.promises.readFile(filePath, "utf8");
		} catch (err: unknown) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code === "ENOENT") {
				throw new Error(`[artifact-store] artifact not found: ${hash}`);
			}
			throw err;
		}
	}

	/**
	 * Render the model-visible chip. Format locked by 8DO 2026-05-09:
	 *   [ARTIFACT <hash> <size>]
	 *   <preview up to 1KB>
	 *   [truncated; full at <path>]
	 *   (run `8gent artifact <hash>` to expand)
	 */
	private renderChip(hash: string, byteLen: number, full: string, filePath: string): string {
		const preview = full.slice(0, PREVIEW_BYTES);
		const lines = [
			`[ARTIFACT ${hash} ${formatSize(byteLen)}]`,
			"",
			preview,
			"",
			`[truncated; full at ${filePath}]`,
			`(run \`8gent artifact <hash>\` to expand)`,
		];
		return lines.join("\n");
	}
}
