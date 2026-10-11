/**
 * Strict reader for npm package tarballs (G2), in process: no system tar.
 *
 * Reads every header before anything is written, so the whole archive is
 * judged first. Accepted: regular files and directories under "package/",
 * with pax ("x") and GNU long-name ("L") headers resolved exactly as tar
 * would resolve them. Refused: links, devices, FIFOs, absolute or "..",
 * backslashes, NUL, a pax global header that sets a path, two entries that
 * collide after NFC + lowercase (they would overwrite each other on macOS and
 * Windows), more than MAX_ENTRIES entries, more than MAX_UNPACKED bytes.
 * The gzip layer is capped too, so a small bomb cannot expand in memory.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { gunzipSync } from "node:zlib";

export const MAX_ENTRIES = 10_000;
export const MAX_UNPACKED = 200 * 1024 * 1024;

export interface TarEntry {
	/** Path relative to package/, "/" separated. Empty for package/ itself. */
	rel: string;
	type: "file" | "dir";
	mode: number;
	data: Uint8Array;
}

function str(buf: Uint8Array, start: number, len: number): string {
	let end = start;
	while (end < start + len && buf[end] !== 0) end++;
	return Buffer.from(buf.subarray(start, end)).toString("utf8");
}

function octal(buf: Uint8Array, start: number, len: number): number {
	// Base-256 (high bit set) sizes are only needed past 8 GB: refuse them.
	if (buf[start] & 0x80) throw new Error("tar: base-256 size field is not accepted");
	const s = str(buf, start, len).trim();
	if (s === "") return 0;
	if (!/^[0-7]+$/.test(s)) throw new Error(`tar: bad octal field "${s}"`);
	return Number.parseInt(s, 8);
}

function parsePax(data: Uint8Array): Record<string, string> {
	const out: Record<string, string> = {};
	const text = Buffer.from(data).toString("utf8");
	let i = 0;
	while (i < text.length) {
		const sp = text.indexOf(" ", i);
		if (sp < 0) break;
		const len = Number.parseInt(text.slice(i, sp), 10);
		if (!Number.isFinite(len) || len <= 0) throw new Error("tar: bad pax record");
		const rec = text.slice(sp + 1, i + len - 1);
		const eq = rec.indexOf("=");
		if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
		i += len;
	}
	return out;
}

/** Validate a member name and return its path under package/. */
function relativeName(name: string): string {
	if (name.includes("\0")) throw new Error("tar: NUL in a member name");
	if (name.includes("\\")) throw new Error(`tar: backslash in member name: ${name}`);
	if (name.startsWith("/") || /^[A-Za-z]:/.test(name))
		throw new Error(`tar: absolute member name: ${name}`);
	const parts = name.split("/").filter((p) => p !== "" && p !== ".");
	if (parts.includes("..")) throw new Error(`tar: ".." in member name: ${name}`);
	if (parts[0] !== "package") throw new Error(`tar: member outside package/: ${name}`);
	return parts.slice(1).join("/");
}

/** Parse a gzipped npm tarball into validated entries. Throws on anything refused. */
export function readNpmTarball(
	gz: Uint8Array,
	limits: { maxEntries?: number; maxUnpacked?: number } = {},
): TarEntry[] {
	const maxEntries = limits.maxEntries ?? MAX_ENTRIES;
	const maxUnpacked = limits.maxUnpacked ?? MAX_UNPACKED;
	let tar: Uint8Array;
	try {
		// The tar framing adds headers and padding on top of the file bytes.
		tar = gunzipSync(gz, { maxOutputLength: maxUnpacked + 16 * 1024 * 1024 });
	} catch (err) {
		throw new Error(`tar: gunzip failed or over the size cap: ${(err as Error).message}`);
	}
	const entries: TarEntry[] = [];
	const seen = new Set<string>();
	let total = 0;
	let pax: Record<string, string> = {};
	let longName: string | null = null;
	let off = 0;
	while (off + 512 <= tar.length) {
		const h = tar.subarray(off, off + 512);
		if (h.every((b) => b === 0)) break;
		const size = octal(h, 124, 12);
		const flag = String.fromCharCode(h[156] || 48);
		const dataStart = off + 512;
		const dataEnd = dataStart + size;
		if (dataEnd > tar.length) throw new Error("tar: member runs past the end of the archive");
		const data = tar.subarray(dataStart, dataEnd);
		off = dataStart + Math.ceil(size / 512) * 512;

		if (flag === "x") {
			pax = parsePax(data);
			continue;
		}
		if (flag === "g") {
			const g = parsePax(data);
			if ("path" in g || "linkpath" in g) throw new Error("tar: pax global header sets a path");
			continue;
		}
		if (flag === "L") {
			longName = str(data, 0, data.length);
			continue;
		}
		const isFile = flag === "0" || flag === "7";
		const isDir = flag === "5";
		if (!isFile && !isDir) {
			throw new Error(`tar: member type "${flag}" (link, device or other) is not accepted`);
		}
		const prefix = str(h, 345, 155);
		const base = str(h, 0, 100);
		const name = pax.path ?? longName ?? (prefix ? `${prefix}/${base}` : base);
		pax = {};
		longName = null;
		const rel = relativeName(name);
		const key = rel.normalize("NFC").toLowerCase();
		if (rel !== "" && seen.has(key)) {
			throw new Error(`tar: "${rel}" collides with another member (case or Unicode form)`);
		}
		seen.add(key);
		if (entries.length >= maxEntries) throw new Error(`tar: more than ${maxEntries} members`);
		total += size;
		if (total > maxUnpacked) throw new Error(`tar: unpacks to more than ${maxUnpacked} bytes`);
		const mode = octal(h, 100, 8);
		entries.push({
			rel,
			type: isDir ? "dir" : "file",
			mode,
			data: isDir ? new Uint8Array() : data,
		});
	}
	return entries;
}

/**
 * Write validated entries under dest (which must not exist yet). Files get
 * 0644, or 0755 when any execute bit was set; nothing else from the archive
 * (owner, times, special bits) is applied.
 */
export function writeEntries(entries: TarEntry[], dest: string): void {
	fs.mkdirSync(dest, { recursive: false });
	const root = path.resolve(dest);
	for (const e of entries) {
		if (e.rel === "") continue;
		const target = path.resolve(root, ...e.rel.split("/"));
		const rel = path.relative(root, target);
		if (rel.startsWith("..") || path.isAbsolute(rel))
			throw new Error(`tar: ${e.rel} escapes the folder`);
		if (e.type === "dir") {
			fs.mkdirSync(target, { recursive: true });
		} else {
			fs.mkdirSync(path.dirname(target), { recursive: true });
			// wx: never follow or replace something already there.
			fs.writeFileSync(target, e.data, { flag: "wx", mode: e.mode & 0o111 ? 0o755 : 0o644 });
		}
	}
}
