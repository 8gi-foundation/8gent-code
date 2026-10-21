/**
 * Source of the inproc-search scan worker, embedded as a string and started from a Blob
 * (#4633). A file-path worker (new Worker(new URL("./x.ts", import.meta.url))) does not
 * exist inside a `bun build --compile` binary, so the worker code travels inside the
 * module instead. It reads files in parallel batches, judges them in path order and
 * posts hits per batch, so a timeout still leaves partial results. Any failure is
 * posted as {error}, never as an empty answer.
 */
export const WORKER_SOURCE = String.raw`
import fs from "node:fs";
import path from "node:path";

self.onmessage = async (ev) => {
	const job = ev.data;
	try {
		const src = job.literal ? job.pattern.replace(/[.*+?^${"$"}{}()|[\]\\]/g, "\\$&") : job.pattern;
		const insensitive = job.ignoreCase ?? !/[A-Z]/.test(job.pattern);
		const matcher = new RegExp(src, insensitive ? "i" : "");
		const whole = new RegExp(src, insensitive ? "im" : "m");
		// ASCII pattern: test raw bytes as latin1 (cheap 1:1 decode), decode utf8 only candidates.
		const ascii = /^[\x20-\x7e]*$/.test(src);
		let scanned = 0;
		let total = 0;
		let truncated = false;
		for (let i = 0; i < job.candidates.length && !truncated; i += 64) {
			const batch = job.candidates.slice(i, i + 64);
			const bufs = await Promise.all(
				batch.map((rel) => fs.promises.readFile(path.join(job.root, ...rel.split("/"))).catch(() => null)),
			);
			const hits = [];
			for (let j = 0; j < batch.length && !truncated; j++) {
				const buf = bufs[j];
				if (!buf || buf.length > job.maxBytes || buf.subarray(0, 8192).includes(0)) continue;
				scanned++;
				if (ascii && !whole.test(buf.toString("latin1"))) continue;
				const text = buf.toString("utf8");
				if (!ascii && !whole.test(text)) continue;
				let perFile = 0;
				const lines = text.split(/\r?\n/);
				for (let n = 0; n < lines.length; n++) {
					if (!matcher.test(lines[n])) continue;
					hits.push({ file: batch[j], line: n + 1, text: lines[n].slice(0, 300) });
					if (total + hits.length >= job.maxResults) { truncated = true; break; }
					if (++perFile >= job.maxPerFile) break;
				}
			}
			total += hits.length;
			self.postMessage({ hits, scanned, truncated: truncated || undefined });
		}
		self.postMessage({ hits: [], scanned, done: true });
	} catch (e) {
		self.postMessage({ hits: [], scanned: 0, error: String((e && e.message) || e) });
	}
};
`;
