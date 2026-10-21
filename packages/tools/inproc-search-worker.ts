/**
 * Content scan for inproc-search, run in a worker so a catastrophic regex can be
 * killed at a wall-clock deadline (#4633). Reads files in parallel batches, judges
 * them in path order, posts hits per batch so a timeout still leaves partial results.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { isMainThread, parentPort } from "node:worker_threads";

export interface ScanJob {
	root: string;
	candidates: string[];
	pattern: string;
	literal: boolean;
	ignoreCase?: boolean;
	maxResults: number;
	maxPerFile: number;
	maxBytes: number;
}
interface Hit {
	file: string;
	line: number;
	text: string;
}

export async function scanFiles(
	job: ScanJob,
	post: (m: { hits: Hit[]; scanned: number; truncated?: boolean; done?: boolean }) => void,
): Promise<{ hits: Hit[]; scanned: number; truncated: boolean }> {
	const src = job.literal ? job.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : job.pattern;
	const insensitive = job.ignoreCase ?? !/[A-Z]/.test(job.pattern);
	const matcher = new RegExp(src, insensitive ? "i" : "");
	const whole = new RegExp(src, insensitive ? "im" : "m");
	// For an ASCII pattern, test raw bytes as latin1 (a 1:1 decode, far cheaper than
	// utf8) and decode properly only a candidate file.
	const asciiPattern = /^[\x20-\x7e]*$/.test(src);
	const all: Hit[] = [];
	let scanned = 0;
	let truncated = false;
	const BATCH = 64;
	for (let i = 0; i < job.candidates.length && !truncated; i += BATCH) {
		const batch = job.candidates.slice(i, i + BATCH);
		const bufs = await Promise.all(
			batch.map((rel) =>
				fs.promises.readFile(path.join(job.root, ...rel.split("/"))).catch(() => null),
			),
		);
		const hits: Hit[] = [];
		for (let j = 0; j < batch.length && !truncated; j++) {
			const buf = bufs[j];
			if (!buf || buf.length > job.maxBytes || buf.subarray(0, 8192).includes(0)) continue; // unreadable, big or binary
			scanned++;
			if (asciiPattern && !whole.test(buf.toString("latin1"))) continue;
			const text = buf.toString("utf8");
			if (!asciiPattern && !whole.test(text)) continue;
			let perFile = 0;
			const lines = text.split(/\r?\n/);
			for (let n = 0; n < lines.length; n++) {
				if (!matcher.test(lines[n])) continue;
				hits.push({ file: batch[j], line: n + 1, text: lines[n].slice(0, 300) });
				if (all.length + hits.length >= job.maxResults) {
					truncated = true;
					break;
				}
				if (++perFile >= job.maxPerFile) break;
			}
		}
		all.push(...hits);
		post({ hits, scanned, truncated: truncated || undefined });
	}
	return { hits: all, scanned, truncated };
}

if (!isMainThread && parentPort) {
	const port = parentPort;
	port.once("message", async (job: ScanJob) => {
		await scanFiles(job, (m) => port.postMessage(m));
		port.postMessage({ hits: [], scanned: 0, done: true });
	});
}
