/** Test fixtures: build raw tar members and gzipped npm tarballs in memory. */
import { gzipSync } from "node:zlib";

/** One raw tar member (ustar header + padded data). */
export function member(
	name: string,
	data: string | Uint8Array = "",
	type = "0",
	opts: { prefix?: string; linkname?: string; size?: number } = {},
): Uint8Array {
	const body = typeof data === "string" ? new TextEncoder().encode(data) : data;
	const h = new Uint8Array(512);
	const put = (s: string, off: number, len: number) =>
		h.set(new TextEncoder().encode(s).subarray(0, len), off);
	put(name, 0, 100);
	put("0000644\0", 100, 8);
	put("0000000\0", 108, 8);
	put("0000000\0", 116, 8);
	put(`${(opts.size ?? body.length).toString(8).padStart(11, "0")}\0`, 124, 12);
	put("00000000000\0", 136, 12);
	put("        ", 148, 8);
	put(type, 156, 1);
	if (opts.linkname) put(opts.linkname, 157, 100);
	put("ustar\0", 257, 6);
	put("00", 263, 2);
	if (opts.prefix) put(opts.prefix, 345, 155);
	let sum = 0;
	for (const b of h) sum += b;
	put(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8);
	const padded = new Uint8Array(Math.ceil(body.length / 512) * 512);
	padded.set(body);
	const out = new Uint8Array(512 + padded.length);
	out.set(h);
	out.set(padded, 512);
	return out;
}

export function pax(records: Record<string, string>): Uint8Array {
	let text = "";
	for (const [k, v] of Object.entries(records)) {
		const rec = ` ${k}=${v}\n`;
		let len = rec.length + 1;
		while (`${len}${rec}`.length !== len) len = `${len}${rec}`.length;
		text += `${len}${rec}`;
	}
	return member("PaxHeader", text, "x");
}

export function tgz(...members: Uint8Array[]): Uint8Array {
	const total = members.reduce((n, m) => n + m.length, 0) + 1024;
	const tar = new Uint8Array(total);
	let o = 0;
	for (const m of members) {
		tar.set(m, o);
		o += m.length;
	}
	return new Uint8Array(gzipSync(tar));
}
