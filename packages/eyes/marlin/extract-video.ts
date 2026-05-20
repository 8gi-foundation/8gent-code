/**
 * @8gent/eyes - `extract_video` tool handler (VIDEO-INGESTION spec §6).
 *
 * Orchestrates the video-ingestion pipeline:
 *   1. Capability gate (off by default, spec §11).
 *   2. Path resolution + container sniff (spec §6 step 1-2, §13).
 *   3. Spawn / initialize the Marlin sidecar (spec §4.3).
 *   4. Chunk-and-merge `caption` per window (spec §8): see chunk-merge.ts
 *      for the §8-vs-§5.5 design decision.
 *   5. `transcribe` the whole file once (spec §5.4, §8 step 6).
 *   6. Optional `find` for a natural-language query (spec §5.3).
 *   7. Assemble a `VideoExtraction` (spec §7).
 *   8. On `ingest: true`, hand off to `@8gent/memory/video-extractor` (#2633)
 *      for stage-2 triple extraction and knowledge-graph write.
 *   9. Sidecar crash → restart once, retry, then a structured error with
 *      the stderr tail (spec §6 step 9, §13).
 *
 * The sidecar binary (#2631) is not on main. The spawn spec is injectable so
 * this handler is fully testable against a fake sidecar fixture.
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

import type { VideoExtractorOptions, VideoIngestResult } from "@8gent/memory/video-extractor";
import type { TranscriptSegment, VideoEvent, VideoExtraction, VideoSpan } from "../types.js";
import { checkVideoCapability, marlinVenvPython } from "./capability.js";
import {
	type CaptionResult,
	MAX_CHUNK_SEC,
	mergeEvents,
	mergeScenes,
	planChunks,
	rebaseEvents,
} from "./chunk-merge.js";
import {
	MarlinSidecarClient,
	SidecarProcessError,
	SidecarRpcError,
	type SidecarSpawnSpec,
} from "./jsonrpc-client.js";
import { resolveVideoPath, sniffIsVideo } from "./video-path.js";

// ---------------------------------------------------------------------------
// Public tool API
// ---------------------------------------------------------------------------

export type ExtractVideoMode = "full" | "visual" | "audio";

export interface ExtractVideoArgs {
	path: string;
	mode?: ExtractVideoMode;
	query?: string;
	ingest?: boolean;
}

/**
 * Ingest hook for `ingest: true`. Takes a `VideoExtraction` and writes it into
 * the knowledge graph via `packages/memory/video-extractor.ts` (#2633). It is
 * a dependency so the tool stays testable without a memory database: a test
 * passes a fake hook, production wires `ingestVideoToGraph`.
 */
export type VideoIngestHook = (
	extraction: VideoExtraction,
) => Promise<VideoIngestResult> | VideoIngestResult;

/** Hooks for testing: lets a test inject a fake sidecar + cwd. */
export interface ExtractVideoDeps {
	/** How to spawn the sidecar. Default: the provisioned venv. */
	spawnSpec?: SidecarSpawnSpec;
	/** Working directory for path resolution. Default: process.cwd(). */
	cwd?: string;
	/** Bypass the capability gate (tests provide their own fake sidecar). */
	skipCapabilityCheck?: boolean;
	/** Progress sink for per-window chunk progress (spec §8). */
	onProgress?: (msg: string) => void;
	/**
	 * Knowledge-graph ingest hook for `ingest: true`. If omitted, the tool
	 * lazily wires the default graph + `ingestVideoToGraph` from
	 * `@8gent/memory/video-extractor`.
	 */
	ingestHook?: VideoIngestHook;
	/** Stage-2 LLM extractor passed through to the default ingest hook. */
	ingestOptions?: VideoExtractorOptions;
}

export type ExtractVideoResult =
	| { ok: true; extraction: VideoExtraction; ingest?: VideoIngestResult }
	| { ok: false; error: ExtractVideoError };

export interface ExtractVideoError {
	kind:
		| "capability_not_installed"
		| "invalid_path"
		| "not_a_video"
		| "sidecar_failure"
		| "decode_failure"
		| "video_too_short";
	message: string;
	/** Sidecar stderr tail on a process failure (spec §6 step 9). */
	stderrTail?: string;
	/** Structured suggestion, e.g. install command or a lower fps. */
	suggestion?: string;
}

// ---------------------------------------------------------------------------
// Sidecar method result shapes (spec §5)
// ---------------------------------------------------------------------------

interface InitializeResult {
	ready: boolean;
	device: string;
	models: { vision: string; audio: string };
}
interface TranscribeResult {
	language: string;
	transcript: TranscriptSegment[];
	hasAudio: boolean;
}
interface FindResult {
	span: VideoSpan | null;
	formatOk: boolean;
}
interface HealthResult {
	durationSec?: number;
}

/** JSON-RPC application error codes from spec §5.8. */
const ERR_VIDEO_DECODE = -33002;
const ERR_UNSUPPORTED_FORMAT = -33003;
const ERR_VIDEO_TOO_SHORT = -33004;

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** Default sidecar spawn spec: `python -m marlin_sidecar` in the venv. */
export function defaultSpawnSpec(): SidecarSpawnSpec {
	return { command: marlinVenvPython(), args: ["-m", "marlin_sidecar"] };
}

/**
 * Run the `extract_video` tool. Returns a discriminated result; the tool
 * registration in `packages/eight/tools.ts` formats it for the model.
 */
export async function extractVideo(
	args: ExtractVideoArgs,
	deps: ExtractVideoDeps = {},
): Promise<ExtractVideoResult> {
	const mode: ExtractVideoMode = args.mode ?? "full";

	// 1. Capability gate (spec §6 step 3, §11): never silently no-op.
	if (!deps.skipCapabilityCheck) {
		const cap = checkVideoCapability();
		if (!cap.installed) {
			return {
				ok: false,
				error: {
					kind: "capability_not_installed",
					message: cap.reason ?? "Video understanding is not installed.",
					suggestion: cap.suggestion ?? "8gent vision install",
				},
			};
		}
	}

	// 2. Path resolution + container sniff (spec §6 step 1-2).
	const resolved = resolveVideoPath(args.path, deps.cwd);
	if (!resolved.ok) {
		return { ok: false, error: { kind: "invalid_path", message: resolved.reason } };
	}
	const absolutePath = resolved.absolutePath;
	if (!sniffIsVideo(absolutePath)) {
		return {
			ok: false,
			error: {
				kind: "not_a_video",
				message: `File is not a recognized video container: ${absolutePath}`,
			},
		};
	}

	// 3-7. Run against the sidecar, with one restart-on-crash retry.
	const spawnSpec = deps.spawnSpec ?? defaultSpawnSpec();
	let lastErr: ExtractVideoError | null = null;
	for (let attempt = 1; attempt <= 2; attempt++) {
		try {
			const extraction = await runWithSidecar(absolutePath, mode, args.query, spawnSpec, deps);
			// 8. ingest handoff: KG write via packages/memory/video-extractor.ts (#2633).
			if (args.ingest) {
				deps.onProgress?.("Ingesting video into the knowledge graph.");
				const ingest = await runIngest(extraction, deps);
				return { ok: true, extraction, ingest };
			}
			return { ok: true, extraction };
		} catch (e) {
			lastErr = classifyError(e);
			// Retry only a process failure, and only once (spec §6 step 9).
			if (lastErr.kind === "sidecar_failure" && attempt === 1) {
				deps.onProgress?.("Marlin sidecar crashed, restarting once and retrying.");
				continue;
			}
			break;
		}
	}
	return { ok: false, error: lastErr ?? { kind: "sidecar_failure", message: "Unknown failure." } };
}

// ---------------------------------------------------------------------------
// Sidecar run
// ---------------------------------------------------------------------------

async function runWithSidecar(
	absolutePath: string,
	mode: ExtractVideoMode,
	query: string | undefined,
	spawnSpec: SidecarSpawnSpec,
	deps: ExtractVideoDeps,
): Promise<VideoExtraction> {
	const client = await MarlinSidecarClient.start(spawnSpec);
	try {
		// initialize (spec §4.3 step 3): slow on first run.
		const init = await client.request<InitializeResult>("initialize");

		// Probe duration via `health` (spec §5.6). The fake sidecar echoes
		// durationSec here so chunk planning is testable.
		const health = await client.request<HealthResult>("health", { path: absolutePath });
		const durationSec = health.durationSec ?? 0;

		// --- Visual side: chunk-and-merge (spec §8) -------------------------
		let scene = "";
		let events: VideoEvent[] = [];
		let chunked = false;
		let chunkCount = 1;
		if (mode === "full" || mode === "visual") {
			const windows = planChunks(durationSec, MAX_CHUNK_SEC);
			chunkCount = Math.max(1, windows.length);
			chunked = windows.length > 1;
			const scenes: string[] = [];
			const rebasedPerWindow: VideoEvent[][] = [];
			const boundaries: number[] = [];
			for (const win of windows) {
				deps.onProgress?.(
					`Captioning window ${win.index + 1}/${windows.length} (${win.startSec.toFixed(1)}s-${win.endSec.toFixed(1)}s).`,
				);
				const cap = await client.request<CaptionResult>("caption", {
					path: absolutePath,
					startSec: win.startSec,
					endSec: win.endSec,
				});
				scenes.push(cap.scene ?? "");
				rebasedPerWindow.push(rebaseEvents(cap.events ?? [], win.startSec, durationSec));
				if (win.index < windows.length - 1) boundaries.push(win.endSec);
			}
			scene = mergeScenes(scenes);
			events = mergeEvents(rebasedPerWindow, boundaries);
		}

		// --- Audio side: one transcribe call, never chunked (spec §8 step 6).
		let transcript: TranscriptSegment[] = [];
		if (mode === "full" || mode === "audio") {
			const tr = await client.request<TranscribeResult>("transcribe", { path: absolutePath });
			transcript = tr.hasAudio ? (tr.transcript ?? []) : [];
		}

		// --- Optional find (spec §5.3) --------------------------------------
		let find: VideoExtraction["find"];
		if (query && query.trim().length > 0) {
			deps.onProgress?.(`Locating query span: "${query}".`);
			const fr = await client.request<FindResult>("find", { path: absolutePath, event: query });
			find = { query, span: fr.span, formatOk: fr.formatOk };
		}

		// --- Assemble VideoExtraction (spec §7) -----------------------------
		const videoId = `sha256:${await hashFile(absolutePath)}`;
		return {
			videoId,
			path: absolutePath,
			durationSec,
			chunked,
			chunkCount,
			scene,
			events: events.slice().sort((a, b) => a.start - b.start || a.end - b.end),
			transcript: transcript.slice().sort((a, b) => a.start - b.start || a.end - b.end),
			...(find ? { find } : {}),
			models: init.models,
			generatedAt: Date.now(),
		};
	} finally {
		await client.stop().catch(() => {
			/* best-effort shutdown */
		});
	}
}

// ---------------------------------------------------------------------------
// Knowledge-graph ingest (spec §6 step 8, §9)
// ---------------------------------------------------------------------------

/**
 * Run the `ingest: true` handoff. Uses the injected `ingestHook` when present
 * (the test path). Otherwise it lazily opens the global memory database and
 * calls `ingestVideoToGraph` from `@8gent/memory/video-extractor`. The memory
 * package is imported dynamically so a build that never sets `ingest: true`
 * does not eagerly load the SQLite-backed graph.
 */
async function runIngest(
	extraction: VideoExtraction,
	deps: ExtractVideoDeps,
): Promise<VideoIngestResult> {
	if (deps.ingestHook) {
		return deps.ingestHook(extraction);
	}

	const { Database } = await import("bun:sqlite");
	const os = await import("node:os");
	const path = await import("node:path");
	const fs = await import("node:fs");
	const { KnowledgeGraph } = await import("@8gent/memory");
	const { ingestVideoToGraph } = await import("@8gent/memory/video-extractor");

	const dbPath = path.join(
		process.env.EIGHT_DATA_DIR || path.join(os.homedir(), ".8gent"),
		"memory",
		"memory.db",
	);
	fs.mkdirSync(path.dirname(dbPath), { recursive: true });

	const db = new Database(dbPath, { create: true });
	try {
		db.run("PRAGMA journal_mode=WAL");
		const graph = new KnowledgeGraph(db);
		return await ingestVideoToGraph(graph, extraction, deps.ingestOptions ?? {});
	} finally {
		db.close();
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** sha256 of the file bytes, streamed so the whole file never sits in RAM. */
function hashFile(absolutePath: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const hash = createHash("sha256");
		const stream = createReadStream(absolutePath);
		stream.on("data", (chunk) => hash.update(chunk));
		stream.on("end", () => resolve(hash.digest("hex")));
		stream.on("error", reject);
	});
}

/** Map a thrown error to a structured ExtractVideoError. */
function classifyError(e: unknown): ExtractVideoError {
	if (e instanceof SidecarRpcError) {
		if (e.code === ERR_VIDEO_DECODE) {
			return {
				kind: "decode_failure",
				message: `Video could not be decoded: ${e.message}`,
				suggestion: "Re-encode the file to H.264 mp4 and try again.",
			};
		}
		if (e.code === ERR_UNSUPPORTED_FORMAT) {
			return {
				kind: "decode_failure",
				message: `Unsupported video container or codec: ${e.message}`,
				suggestion: "Re-encode the file to H.264 mp4 and try again.",
			};
		}
		if (e.code === ERR_VIDEO_TOO_SHORT) {
			return {
				kind: "video_too_short",
				message:
					"Video is too short to caption (fewer than 4 sampled frames). A transcript may still be available.",
			};
		}
		const data = e.data as { suggestion?: string } | undefined;
		return {
			kind: "sidecar_failure",
			message: e.message,
			...(data?.suggestion ? { suggestion: data.suggestion } : {}),
		};
	}
	if (e instanceof SidecarProcessError) {
		return {
			kind: "sidecar_failure",
			message: e.message,
			stderrTail: e.stderrTail,
		};
	}
	return {
		kind: "sidecar_failure",
		message: e instanceof Error ? e.message : String(e),
	};
}

// ---------------------------------------------------------------------------
// Result formatting for the tool registration in packages/eight/tools.ts
// ---------------------------------------------------------------------------

/** Render an ExtractVideoResult as the string the model sees. */
export function formatExtractVideoResult(result: ExtractVideoResult): string {
	if (!result.ok) {
		const { error } = result;
		const lines = [`[extract_video error: ${error.kind}] ${error.message}`];
		if (error.suggestion) lines.push(`Suggestion: ${error.suggestion}`);
		if (error.stderrTail) lines.push(`Sidecar stderr (tail):\n${error.stderrTail}`);
		return lines.join("\n");
	}
	const e = result.extraction;
	const lines = [
		`Video: ${e.path}`,
		`Duration: ${e.durationSec.toFixed(1)}s${e.chunked ? ` (chunked into ${e.chunkCount} windows)` : ""}`,
		`Scene: ${e.scene || "(none)"}`,
		`Events (${e.events.length}):`,
		...e.events.map((ev) => `  ${ev.start.toFixed(1)}s-${ev.end.toFixed(1)}s  ${ev.description}`),
		`Transcript (${e.transcript.length} segments):`,
		...e.transcript.map((t) => `  ${t.start.toFixed(1)}s-${t.end.toFixed(1)}s  ${t.text}`),
	];
	if (e.find) {
		lines.push(
			e.find.span
				? `Query "${e.find.query}" found at ${e.find.span.start.toFixed(1)}s-${e.find.span.end.toFixed(1)}s.`
				: `Query "${e.find.query}" not found in the video.`,
		);
	}
	lines.push(`videoId: ${e.videoId}`);
	if (result.ingest) {
		lines.push(
			`Ingested into the knowledge graph: ${result.ingest.entitiesCreated} entities, ` +
				`${result.ingest.relationshipsCreated} relationships` +
				`${result.ingest.stage2Ran ? " (with triple extraction)" : ""}.`,
		);
	}
	return lines.join("\n");
}
