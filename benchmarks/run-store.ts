/**
 * Per-item result files for resumable benchmark runs (issue #3557).
 *
 * A run directory holds `_run.json` (model, provider, seed) plus one
 * `<benchmarkId>.json` per finished item. Each item file is written to a
 * temp name and renamed, so an interrupted run never leaves a half-written
 * result behind. Resuming into a directory recorded with a different model,
 * provider or seed is refused rather than mixing results across configs.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface RunHeader {
	model: string;
	provider: string;
	seed?: number;
}

const HEADER_FILE = "_run.json";

export function openRun(dir: string, header: RunHeader): void {
	fs.mkdirSync(dir, { recursive: true });
	const headerPath = path.join(dir, HEADER_FILE);
	if (fs.existsSync(headerPath)) {
		const prev: RunHeader = JSON.parse(fs.readFileSync(headerPath, "utf-8"));
		for (const key of ["model", "provider", "seed"] as const) {
			if (prev[key] !== header[key]) {
				throw new Error(
					`Cannot resume ${dir}: ${key} was ${prev[key] ?? "unset"}, now ${header[key] ?? "unset"}`,
				);
			}
		}
		return;
	}
	writeAtomic(headerPath, { ...header, startedAt: new Date().toISOString() });
}

export function saveResult<T extends { benchmarkId: string }>(dir: string, result: T): void {
	writeAtomic(path.join(dir, `${result.benchmarkId}.json`), result);
}

export function loadDone<T extends { benchmarkId: string }>(dir: string): Map<string, T> {
	const done = new Map<string, T>();
	if (!fs.existsSync(dir)) return done;
	for (const name of fs.readdirSync(dir)) {
		if (!name.endsWith(".json") || name === HEADER_FILE) continue;
		const result: T = JSON.parse(fs.readFileSync(path.join(dir, name), "utf-8"));
		done.set(result.benchmarkId, result);
	}
	return done;
}

function writeAtomic(file: string, data: unknown): void {
	const tmp = `${file}.tmp-${process.pid}`;
	fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
	fs.renameSync(tmp, file);
}
