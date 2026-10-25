/**
 * Control state reader (#5062, slice 1 of #5067).
 *
 * Turns local state files into loop rows. Read-only: nothing here writes,
 * spawns or opens a socket. Each owner points the reader at their own files
 * through ~/.8gent/control.json; nothing is hardcoded to one person's paths.
 *
 *   {
 *     "sources": [
 *       { "type": "merge-ready", "path": "~/ledgers/merge-ready.txt", "queueLog": "~/ledgers/merge-log.jsonl" },
 *       { "type": "jobs", "dir": "~/.8gent/jobs" }
 *     ],
 *     "staleAfterMin": 60, "helperCap": 4, "diskFloorGB": 30
 *   }
 *
 * With no config file the reader uses the generic jobs folder only. A source
 * that is missing or unreadable is skipped, never an error.
 *
 * Built-in readers:
 *   jobs         ~/.8gent/jobs/*.json, one JSON per loop, so any loop reports
 *                itself by writing one file.
 *   merge-ready  lines "MERGE-OK <repo>#N at <sha>: <evidence>" plus an
 *                optional queue log (JSON lines with `pr`, `ts`, `merge_commit`)
 *                that marks which of them already merged.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type LoopState = "waiting-on-you" | "running" | "queued" | "stalled" | "done";

export interface LoopRow {
	kind: string;
	name: string;
	state: LoopState;
	stage: string;
	last: string | null;
	next: string | null;
	waitingOn: string | null;
	detail: string;
}

export interface ControlConfig {
	sources: ControlSource[];
	staleAfterMin: number;
	helperCap: number | null;
	diskFloorGB: number | null;
}

export type ControlSource =
	| { type: "jobs"; dir: string }
	| { type: "merge-ready"; path: string; queueLog?: string; limit?: number };

export interface ReadResult {
	rows: LoopRow[];
	/** One short line per file or line that could not be used. */
	problems: string[];
}

export interface ReadDeps {
	home?: string;
	now?: () => number;
	readFile?: (p: string) => string;
	readTail?: (p: string, bytes: number) => string;
	listDir?: (p: string) => string[];
	mtimeMs?: (p: string) => number;
}

const STATES: readonly LoopState[] = ["waiting-on-you", "running", "queued", "stalled", "done"];
/** Display order of the groups, most urgent first. `done` is never listed. */
export const STATE_ORDER: readonly LoopState[] = ["waiting-on-you", "running", "queued", "stalled"];
const TAIL_BYTES = 128 * 1024;
const DEFAULT_STALE_MIN = 60;
const DEFAULT_MERGE_LIMIT = 8;

export function controlHome(env: Record<string, string | undefined> = process.env): string {
	return env.HOME || os.homedir();
}

export function configPath(home: string): string {
	return path.join(home, ".8gent", "control.json");
}

export function expandHome(p: string, home: string): string {
	if (p === "~") return home;
	if (p.startsWith("~/")) return path.join(home, p.slice(2));
	return p;
}

const defaultReadFile = (p: string) => fs.readFileSync(p, "utf8");
const defaultListDir = (p: string) => fs.readdirSync(p);
const defaultMtime = (p: string) => fs.statSync(p).mtimeMs;
function defaultReadTail(p: string, bytes: number): string {
	const fd = fs.openSync(p, "r");
	try {
		const size = fs.fstatSync(fd).size;
		const start = Math.max(0, size - bytes);
		const buf = Buffer.alloc(size - start);
		fs.readSync(fd, buf, 0, buf.length, start);
		const text = buf.toString("utf8");
		// A tail that starts mid-line drops its first, partial line.
		return start > 0 ? text.slice(text.indexOf("\n") + 1) : text;
	} finally {
		fs.closeSync(fd);
	}
}

function num(v: unknown, fallback: number | null): number | null {
	return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : fallback;
}

/** Read the reader config. Missing or malformed file gives the generic default. */
export function loadControlConfig(deps: ReadDeps = {}): ControlConfig {
	const home = deps.home ?? controlHome();
	const read = deps.readFile ?? defaultReadFile;
	const fallback: ControlConfig = {
		sources: [{ type: "jobs", dir: path.join(home, ".8gent", "jobs") }],
		staleAfterMin: DEFAULT_STALE_MIN,
		helperCap: null,
		diskFloorGB: null,
	};
	let raw: unknown;
	try {
		raw = JSON.parse(read(configPath(home)));
	} catch {
		return fallback;
	}
	if (!raw || typeof raw !== "object") return fallback;
	const o = raw as Record<string, unknown>;
	const sources: ControlSource[] = [];
	if (Array.isArray(o.sources)) {
		for (const s of o.sources) {
			if (!s || typeof s !== "object") continue;
			const src = s as Record<string, unknown>;
			if (src.type === "jobs" && typeof src.dir === "string") {
				sources.push({ type: "jobs", dir: expandHome(src.dir, home) });
			} else if (src.type === "merge-ready" && typeof src.path === "string") {
				sources.push({
					type: "merge-ready",
					path: expandHome(src.path, home),
					queueLog: typeof src.queueLog === "string" ? expandHome(src.queueLog, home) : undefined,
					limit: num(src.limit, null) ?? undefined,
				});
			}
		}
	}
	return {
		sources: Array.isArray(o.sources) ? sources : fallback.sources,
		staleAfterMin: num(o.staleAfterMin, DEFAULT_STALE_MIN) ?? DEFAULT_STALE_MIN,
		helperCap: num(o.helperCap, null),
		diskFloorGB: num(o.diskFloorGB, null),
	};
}

/** The files and folders to watch for this config, existing or not. */
export function watchTargets(cfg: ControlConfig): string[] {
	const out = new Set<string>();
	for (const s of cfg.sources) {
		if (s.type === "jobs") out.add(s.dir);
		else {
			out.add(s.path);
			if (s.queueLog) out.add(s.queueLog);
		}
	}
	return [...out];
}

/** "14:22" for an ISO string or epoch ms; any other text is shown as written. */
export function fmtWhen(v: unknown): string | null {
	if (v === null || v === undefined || v === "") return null;
	let d: Date | null = null;
	if (typeof v === "number" && Number.isFinite(v)) d = new Date(v);
	else if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v)) d = new Date(v);
	if (d && !Number.isNaN(d.getTime())) {
		const hh = String(d.getHours()).padStart(2, "0");
		const mm = String(d.getMinutes()).padStart(2, "0");
		return `${hh}:${mm}`;
	}
	return typeof v === "string" ? v : null;
}

function str(v: unknown): string {
	return typeof v === "string" ? v : "";
}

function readJobs(
	dir: string,
	cfg: ControlConfig,
	d: Required<Pick<ReadDeps, "now" | "readFile" | "listDir" | "mtimeMs">>,
	problems: string[],
): LoopRow[] {
	let names: string[];
	try {
		names = d.listDir(dir);
	} catch {
		return [];
	}
	const rows: LoopRow[] = [];
	for (const file of names.filter((n) => n.endsWith(".json")).sort()) {
		const full = path.join(dir, file);
		let o: Record<string, unknown>;
		try {
			const parsed = JSON.parse(d.readFile(full));
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
				throw new Error("not an object");
			o = parsed as Record<string, unknown>;
		} catch {
			problems.push(`${file}: not valid JSON`);
			continue;
		}
		if (!STATES.includes(o.state as LoopState)) {
			problems.push(`${file}: unknown state`);
			continue;
		}
		let state = o.state as LoopState;
		let waitingOn = str(o.waitingOn) || null;
		// A running loop that stopped reporting is stalled, not running.
		if (state === "running") {
			const staleMin = num(o.staleAfterMin, cfg.staleAfterMin) ?? cfg.staleAfterMin;
			if (staleMin > 0) {
				let age = 0;
				try {
					age = d.now() - d.mtimeMs(full);
				} catch {}
				if (age > staleMin * 60_000) {
					state = "stalled";
					waitingOn = waitingOn ?? `no update for ${Math.round(age / 60_000)}m`;
				}
			}
		}
		rows.push({
			kind: str(o.kind) || "loop",
			name: str(o.name) || file.replace(/\.json$/, ""),
			state,
			stage: str(o.stage),
			last: fmtWhen(o.last),
			next: fmtWhen(o.next),
			waitingOn,
			detail: str(o.detail),
		});
	}
	return rows;
}

const MERGE_LINE = /^MERGE-OK\s+(\S+?)#(\d+)\s+at\s+([0-9a-f]{7,40}):\s*(.*)$/;

function readMergeReady(
	src: Extract<ControlSource, { type: "merge-ready" }>,
	d: Required<Pick<ReadDeps, "readTail" | "readFile">>,
	problems: string[],
): LoopRow[] {
	let text: string;
	try {
		text = d.readTail(src.path, TAIL_BYTES);
	} catch {
		return [];
	}
	const merged = new Map<number, string | null>();
	if (src.queueLog) {
		try {
			for (const line of d.readTail(src.queueLog, TAIL_BYTES).split("\n")) {
				if (!line.trim()) continue;
				try {
					const j = JSON.parse(line) as Record<string, unknown>;
					if (typeof j.pr === "number" && j.merge_commit) merged.set(j.pr, fmtWhen(j.ts));
				} catch {
					problems.push("queue log: skipped a malformed line");
				}
			}
		} catch {}
	}
	// Latest MERGE-OK per PR wins; a later line replaces an earlier one.
	const latest = new Map<string, { repo: string; pr: number; sha: string; evidence: string }>();
	for (const line of text.split("\n")) {
		if (!line.startsWith("MERGE-OK")) continue;
		const m = MERGE_LINE.exec(line.trim());
		if (!m) {
			problems.push("merge-ready: skipped a malformed MERGE-OK line");
			continue;
		}
		const key = `${m[1]}#${m[2]}`;
		latest.delete(key);
		latest.set(key, { repo: m[1], pr: Number(m[2]), sha: m[3], evidence: m[4] });
	}
	const limit = src.limit ?? DEFAULT_MERGE_LIMIT;
	return [...latest.values()].slice(-limit).map((e) => {
		const mergedAt = merged.get(e.pr);
		const isMerged = mergedAt !== undefined;
		return {
			kind: "merge",
			name: `${e.repo.split("/").pop()}#${e.pr}`,
			state: isMerged ? "done" : "queued",
			stage: isMerged ? "merged" : "MERGE-OK",
			last: isMerged ? mergedAt : null,
			next: isMerged ? null : "merge",
			waitingOn: isMerged ? null : "merge",
			detail: `at ${e.sha.slice(0, 9)}: ${e.evidence}`.slice(0, 240),
		};
	});
}

/** Urgency order: state group first, then name. Stable and total. */
export function orderRows(rows: readonly LoopRow[]): LoopRow[] {
	const rank = (s: LoopState) => {
		const i = STATE_ORDER.indexOf(s);
		return i < 0 ? STATE_ORDER.length : i;
	};
	return [...rows].sort((a, b) => rank(a.state) - rank(b.state) || a.name.localeCompare(b.name));
}

/** Read every configured source. Missing sources are skipped without error. */
export function readControlState(cfg: ControlConfig, deps: ReadDeps = {}): ReadResult {
	const d = {
		now: deps.now ?? Date.now,
		readFile: deps.readFile ?? defaultReadFile,
		readTail: deps.readTail ?? defaultReadTail,
		listDir: deps.listDir ?? defaultListDir,
		mtimeMs: deps.mtimeMs ?? defaultMtime,
	};
	const problems: string[] = [];
	const rows: LoopRow[] = [];
	for (const src of cfg.sources) {
		try {
			if (src.type === "jobs") rows.push(...readJobs(src.dir, cfg, d, problems));
			else rows.push(...readMergeReady(src, d, problems));
		} catch {
			problems.push(`${src.type}: unreadable`);
		}
	}
	return { rows: orderRows(rows), problems };
}
