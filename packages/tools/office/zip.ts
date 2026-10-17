/**
 * 8gent Code - the zip container under Word, Excel and PowerPoint files (#4274).
 *
 * A .docx, .xlsx or .pptx is a plain zip of XML parts. Writing one needs CRC32,
 * DEFLATE (node:zlib) and two kinds of header, so this is built here rather than
 * pulled in as a dependency. Every entry gets the same fixed timestamp, so the
 * same parts always give the same bytes.
 *
 * The reader walks the central directory and inflates only the parts asked for,
 * with limits on entry count and inflated size so a hostile file cannot exhaust
 * memory (a zip bomb). Zip64 and encrypted entries are refused.
 */

import * as zlib from "node:zlib";

const CRC_TABLE = (() => {
	const t = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		t[n] = c >>> 0;
	}
	return t;
})();

export function crc32(buf: Uint8Array): number {
	let c = 0xffffffff;
	for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

/** 1980-01-01 00:00, the zip epoch: a fixed stamp keeps output byte-identical run to run. */
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;

export interface ZipEntry {
	name: string;
	data: Buffer | string;
}

/** Zip the entries in the order given. Names are stored UTF-8 (flag bit 11). */
export function writeZip(entries: ZipEntry[]): Buffer {
	const locals: Buffer[] = [];
	const centrals: Buffer[] = [];
	let offset = 0;
	const seen = new Set<string>();
	for (const e of entries) {
		if (seen.has(e.name)) throw new Error(`duplicate zip entry "${e.name}"`);
		seen.add(e.name);
		const raw = typeof e.data === "string" ? Buffer.from(e.data, "utf8") : e.data;
		const name = Buffer.from(e.name, "utf8");
		const deflated = zlib.deflateRawSync(raw, { level: 6 });
		// Already-compressed media (png, jpeg) can grow under DEFLATE; store those as-is.
		const stored = deflated.length >= raw.length;
		const body = stored ? raw : deflated;
		const method = stored ? 0 : 8;
		const crc = crc32(raw);

		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(0x0800, 6);
		local.writeUInt16LE(method, 8);
		local.writeUInt16LE(DOS_TIME, 10);
		local.writeUInt16LE(DOS_DATE, 12);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(body.length, 18);
		local.writeUInt32LE(raw.length, 22);
		local.writeUInt16LE(name.length, 26);
		local.writeUInt16LE(0, 28);
		locals.push(local, name, body);

		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(20, 4);
		central.writeUInt16LE(20, 6);
		central.writeUInt16LE(0x0800, 8);
		central.writeUInt16LE(method, 10);
		central.writeUInt16LE(DOS_TIME, 12);
		central.writeUInt16LE(DOS_DATE, 14);
		central.writeUInt32LE(crc, 16);
		central.writeUInt32LE(body.length, 20);
		central.writeUInt32LE(raw.length, 24);
		central.writeUInt16LE(name.length, 28);
		central.writeUInt32LE(offset, 42);
		centrals.push(central, name);

		offset += 30 + name.length + body.length;
	}
	const cdSize = centrals.reduce((n, b) => n + b.length, 0);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(cdSize, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...locals, ...centrals, end]);
}

/** Limits for reading a zip someone else made. */
export const MAX_ZIP_ENTRIES = 5000;
export const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
export const MAX_TOTAL_INFLATED = 256 * 1024 * 1024;

interface CentralRecord {
	method: number;
	compressed: number;
	size: number;
	localOffset: number;
	flags: number;
}

export interface ZipReader {
	names(): string[];
	has(name: string): boolean;
	/** The part as UTF-8 text, or null when the zip has no such part. */
	text(name: string): string | null;
}

/** Open a zip held in memory. Throws a plain reason on anything malformed or out of bounds. */
export function readZip(buf: Buffer): ZipReader {
	let eocd = -1;
	for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
		if (buf.readUInt32LE(i) === 0x06054b50) {
			eocd = i;
			break;
		}
	}
	if (eocd < 0) throw new Error("not a zip file (no end-of-directory record)");
	const count = buf.readUInt16LE(eocd + 10);
	const cdOffset = buf.readUInt32LE(eocd + 16);
	if (count === 0xffff || cdOffset === 0xffffffff)
		throw new Error("zip64 archives are not supported");
	if (count > MAX_ZIP_ENTRIES)
		throw new Error(`zip has ${count} entries; the limit is ${MAX_ZIP_ENTRIES}`);
	const records = new Map<string, CentralRecord>();
	let p = cdOffset;
	for (let n = 0; n < count; n++) {
		if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) {
			throw new Error("zip central directory is damaged");
		}
		const nameLen = buf.readUInt16LE(p + 28);
		const extraLen = buf.readUInt16LE(p + 30);
		const commentLen = buf.readUInt16LE(p + 32);
		const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
		records.set(name, {
			flags: buf.readUInt16LE(p + 8),
			method: buf.readUInt16LE(p + 10),
			compressed: buf.readUInt32LE(p + 20),
			size: buf.readUInt32LE(p + 24),
			localOffset: buf.readUInt32LE(p + 42),
		});
		p += 46 + nameLen + extraLen + commentLen;
	}
	let inflated = 0;
	return {
		names: () => [...records.keys()],
		has: (name) => records.has(name),
		text(name) {
			const r = records.get(name);
			if (!r) return null;
			if (r.flags & 1) throw new Error(`zip entry "${name}" is encrypted`);
			if (r.size > MAX_ENTRY_BYTES) {
				throw new Error(
					`zip entry "${name}" inflates to ${r.size} bytes; the limit is ${MAX_ENTRY_BYTES}`,
				);
			}
			const lp = r.localOffset;
			if (lp + 30 > buf.length || buf.readUInt32LE(lp) !== 0x04034b50) {
				throw new Error(`zip entry "${name}" has no local header`);
			}
			const start = lp + 30 + buf.readUInt16LE(lp + 26) + buf.readUInt16LE(lp + 28);
			const body = buf.subarray(start, start + r.compressed);
			if (body.length !== r.compressed) throw new Error(`zip entry "${name}" is truncated`);
			let out: Buffer;
			if (r.method === 0) out = Buffer.from(body);
			else if (r.method === 8) {
				out = zlib.inflateRawSync(body, { maxOutputLength: MAX_ENTRY_BYTES });
			} else throw new Error(`zip entry "${name}" uses compression method ${r.method}`);
			inflated += out.length;
			if (inflated > MAX_TOTAL_INFLATED) {
				throw new Error(`zip inflates past ${MAX_TOTAL_INFLATED} bytes; refusing to read further`);
			}
			return out.toString("utf8");
		},
	};
}
