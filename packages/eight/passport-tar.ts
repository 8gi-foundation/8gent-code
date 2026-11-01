/**
 * Bounded, in-process reader for passport archives (#5086).
 *
 * The passport is gunzipped here with a hard output cap, and the 512-byte tar headers are
 * parsed here, so no limit depends on the text `tar -tv` prints (a uname or gname is free text
 * and can shift its columns). System tar never reads an imported passport.
 *
 * Accepted entry types: regular file ("0" or NUL), folder ("5"), pax extended header ("x",
 * path and size honoured), pax global header ("g", ignored) and GNU long name ("L").
 * Anything else (links, devices, FIFOs, GNU long link, sparse) is refused.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { gunzipSync } from "node:zlib";

export interface TarLimits {
	maxFileBytes: number;
	maxTotalBytes: number;
	maxEntries: number;
}

export class TarRefusal extends Error {}

const BLOCK = 512;
/** Headers, padding and metadata records on top of file content. */
const OVERHEAD = 16 * 1024 * 1024;
const MAX_META_BYTES = 64 * 1024;

const cstr = (b: Buffer, start: number, len: number) => {
	const s = b.subarray(start, start + len);
	const nul = s.indexOf(0);
	return s.subarray(0, nul < 0 ? len : nul).toString("utf-8");
};

function octal(b: Buffer, start: number, len: number, what: string): number {
	// A base-256 size (high bit set) is only for files far over any cap here.
	if (b[start] & 0x80) throw new TarRefusal(`${what} uses a binary size`);
	const s = cstr(b, start, len).trim();
	if (s === "") return 0;
	if (!/^[0-7]+$/.test(s)) throw new TarRefusal(`${what} has an unreadable size`);
	return Number.parseInt(s, 8);
}

function checksumOk(h: Buffer): boolean {
	let sum = 0;
	for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i];
	return sum === octal(h, 148, 8, "a header");
}

function paxRecords(data: Buffer): Map<string, string> {
	const out = new Map<string, string>();
	let i = 0;
	while (i < data.length) {
		const sp = data.indexOf(0x20, i);
		if (sp < 0) throw new TarRefusal("a pax record is malformed");
		const len = Number(data.subarray(i, sp).toString("ascii"));
		if (!Number.isInteger(len) || len <= sp - i || i + len > data.length)
			throw new TarRefusal("a pax record is malformed");
		const rec = data.subarray(sp + 1, i + len - 1).toString("utf-8");
		const eq = rec.indexOf("=");
		if (eq < 0) throw new TarRefusal("a pax record is malformed");
		out.set(rec.slice(0, eq), rec.slice(eq + 1));
		i += len;
	}
	return out;
}

/** The archive-relative path, or a refusal when it is absolute, climbs, or leaves `root/`. */
function entryPath(raw: string, root: string): string {
	const p = raw.replace(/^(\.\/)+/, "").replace(/\/+$/, "");
	if (p.includes("\\") || p.includes("\0")) throw new TarRefusal(`entry ${p} has an unsafe name`);
	if (p.startsWith("/")) throw new TarRefusal(`absolute path entry: ${p}`);
	if (p.split("/").some((s) => s === ".." || s === "." || s === ""))
		throw new TarRefusal(`parent-traversal entry: ${p}`);
	if (p !== root && !p.startsWith(`${root}/`))
		throw new TarRefusal(`entry outside expected root '${root}': ${p}`);
	return p;
}

export interface TarEntry {
	path: string;
	dir: boolean;
	data: Buffer;
}

/**
 * Gunzip `file` within the caps and check every header. Nothing is written: every limit is
 * checked for the whole archive before writeEntries puts a byte on disk.
 */
export function readBounded(file: string, root: string, limits: TarLimits): TarEntry[] {
	let tar: Buffer;
	try {
		tar = gunzipSync(fs.readFileSync(file), { maxOutputLength: limits.maxTotalBytes + OVERHEAD });
	} catch (e) {
		if (e instanceof RangeError || (e as { code?: string }).code === "ERR_BUFFER_TOO_LARGE")
			throw new TarRefusal(`the passport unpacks to over ${limits.maxTotalBytes / 1048576} MB`);
		throw new TarRefusal("this is not a readable passport file");
	}

	const entries: TarEntry[] = [];
	/** Folded keys: on a case-insensitive disk (macOS, Windows) "A" and "a" are one path. */
	const seen = new Set<string>();
	let total = 0;
	let pax = new Map<string, string>();
	let longName: string | undefined;
	let off = 0;
	for (;;) {
		if (off + BLOCK > tar.length) throw new TarRefusal("the archive ends early");
		const h = tar.subarray(off, off + BLOCK);
		if (h.every((b) => b === 0)) break;
		if (!checksumOk(h)) throw new TarRefusal("a tar header checksum does not match");
		const type = String.fromCharCode(h[156] || 0x30);
		let size = octal(h, 124, 12, "an entry");
		if (type === "0" || type === "5") {
			const paxSize = pax.get("size");
			if (paxSize !== undefined) {
				if (!/^\d+$/.test(paxSize)) throw new TarRefusal("a pax size is unreadable");
				size = Number(paxSize);
			}
		}
		const dataStart = off + BLOCK;
		const dataEnd = dataStart + size;
		if (dataEnd > tar.length) throw new TarRefusal("the archive ends early");
		const data = tar.subarray(dataStart, dataEnd);
		off = dataStart + Math.ceil(size / BLOCK) * BLOCK;

		if (type === "x" || type === "g" || type === "L") {
			if (size > MAX_META_BYTES) throw new TarRefusal("a metadata record is too large");
			if (type === "x") pax = paxRecords(data);
			if (type === "L") longName = cstr(data, 0, data.length);
			continue;
		}
		if (type !== "0" && type !== "5")
			throw new TarRefusal("the passport holds a link or special file");

		const ustar = cstr(h, 257, 6) === "ustar";
		const prefix = ustar ? cstr(h, 345, 155) : "";
		const headerName = prefix ? `${prefix}/${cstr(h, 0, 100)}` : cstr(h, 0, 100);
		const p = entryPath(pax.get("path") ?? longName ?? headerName, root);
		pax = new Map();
		longName = undefined;

		if (entries.length + 1 > limits.maxEntries)
			throw new TarRefusal(`the passport has more than ${limits.maxEntries} entries`);
		const key = p.normalize("NFC").toLowerCase();
		if (seen.has(key)) throw new TarRefusal(`entry ${p} appears twice (letter case ignored)`);
		seen.add(key);
		if (type === "5") {
			if (size !== 0) throw new TarRefusal(`folder ${p} carries data`);
			entries.push({ path: p, dir: true, data });
			continue;
		}
		if (size > limits.maxFileBytes)
			throw new TarRefusal(`an entry is over ${limits.maxFileBytes / 1048576} MB`);
		total += size;
		if (total > limits.maxTotalBytes)
			throw new TarRefusal(`the passport unpacks to over ${limits.maxTotalBytes / 1048576} MB`);
		entries.push({ path: p, dir: false, data });
	}
	if (entries.length === 0) throw new TarRefusal("archive has no entries");
	const files = new Set(entries.filter((e) => !e.dir).map((e) => e.path));
	for (const e of entries) {
		// Nothing may sit under a path that is a file.
		const parts = e.path.split("/");
		for (let i = 1; i < parts.length; i++) {
			if (files.has(parts.slice(0, i).join("/")))
				throw new TarRefusal(`entry ${e.path} sits under a file`);
		}
	}
	return entries;
}

/** Write checked entries under dest: folders made here, files created exclusively, no links. */
export function writeEntries(entries: TarEntry[], dest: string): void {
	for (const e of entries) {
		const abs = path.join(dest, ...e.path.split("/"));
		if (e.dir) {
			fs.mkdirSync(abs, { recursive: true });
			continue;
		}
		fs.mkdirSync(path.dirname(abs), { recursive: true });
		try {
			fs.writeFileSync(abs, e.data, { flag: "wx", mode: 0o600 });
		} catch (err) {
			// Two names this disk sees as one: refuse rather than overwrite or crash.
			if ((err as { code?: string }).code === "EEXIST")
				throw new TarRefusal(`entry ${e.path} collides with another on this disk`);
			throw err;
		}
	}
}
