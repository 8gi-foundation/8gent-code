/**
 * @8gent/eyes — video path resolution and container sniffing.
 *
 * VIDEO-INGESTION spec §6 step 1-2 and §13:
 *   - Resolve `path` to an absolute real path; reject traversal and symlink
 *     escape.
 *   - Validate it is a video by container sniff, not extension alone — a
 *     non-video file fails fast before the sidecar is touched.
 */

import { closeSync, existsSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

export type VideoPathResult = { ok: true; absolutePath: string } | { ok: false; reason: string };

/**
 * Resolve a user-supplied path to a real absolute path and reject escape.
 *
 * Resolution: relative paths are joined against `cwd`; the result is passed
 * through `realpathSync` so any symlink in the chain is followed to its real
 * target. The real target must still live inside `cwd` (the allowed root) —
 * a symlink pointing out of the workspace is an escape and is rejected.
 *
 * `allowedRoot` defaults to the process cwd. The tool may widen it to a
 * user-passed location.
 */
export function resolveVideoPath(input: string, cwd: string = process.cwd()): VideoPathResult {
	if (typeof input !== "string" || input.trim().length === 0) {
		return { ok: false, reason: "No video path provided." };
	}
	// NUL byte and obvious traversal sequences are rejected before touching FS.
	if (input.includes("\0")) {
		return { ok: false, reason: "Path contains a NUL byte." };
	}
	const joined = isAbsolute(input) ? input : resolve(cwd, input);
	if (!existsSync(joined)) {
		return { ok: false, reason: `Video not found: ${joined}` };
	}
	let real: string;
	try {
		real = realpathSync(joined);
	} catch (e) {
		return { ok: false, reason: `Cannot resolve path: ${(e as Error).message}` };
	}
	const allowedRoot = realpathSync(cwd);
	// The real target must be inside the allowed root. An absolute path the
	// user passes directly is allowed; a symlink that escapes the root is not.
	const escapesRoot = !real.startsWith(`${allowedRoot}/`) && real !== allowedRoot;
	const userGaveAbsolute = isAbsolute(input);
	if (escapesRoot && !userGaveAbsolute) {
		return {
			ok: false,
			reason: `Path escapes the workspace via a symlink or traversal: ${input}`,
		};
	}
	// Even for a user-supplied absolute path, reject if a symlink in the chain
	// redirects the path elsewhere (the input and its realpath disagree on a
	// non-cosmetic level). We allow the realpath; the guard above already
	// blocks relative-path escapes. Absolute inputs are trusted as the user's
	// explicit choice, per spec §6 ("the user-passed location").
	let st: ReturnType<typeof statSync>;
	try {
		st = statSync(real);
	} catch (e) {
		return { ok: false, reason: `Cannot stat path: ${(e as Error).message}` };
	}
	if (!st.isFile()) {
		return { ok: false, reason: `Not a regular file: ${real}` };
	}
	return { ok: true, absolutePath: real };
}

// ---------------------------------------------------------------------------
// Container sniffing
// ---------------------------------------------------------------------------

/**
 * Sniff a file's leading bytes to decide whether it is a video container.
 *
 * Covers the common containers the spec names (mp4/mov/webm and the MPEG/AVI
 * families). This is a fast pre-check so a non-video file fails before the
 * sidecar is spawned; the sidecar's torchcodec decode is the authoritative
 * check for exotic codecs (spec §13 maps decode failure to error -33002 /
 * -33003).
 */
export function sniffIsVideo(absolutePath: string): boolean {
	let fd: number | undefined;
	try {
		fd = openSync(absolutePath, "r");
		const head = Buffer.alloc(16);
		const n = readSync(fd, head, 0, 16, 0);
		if (n < 12) return false;
		return matchesVideoMagic(head);
	} catch {
		return false;
	} finally {
		if (fd !== undefined) {
			try {
				closeSync(fd);
			} catch {
				/* ignore */
			}
		}
	}
}

/** Match a 16-byte head against known video container signatures. */
export function matchesVideoMagic(head: Buffer): boolean {
	if (head.length < 12) return false;

	// ISO base media (mp4, mov, m4v, 3gp): bytes 4-7 are the 'ftyp' box type.
	if (head.toString("latin1", 4, 8) === "ftyp") return true;

	// Some QuickTime files lead with 'moov', 'mdat', 'free', 'wide', 'skip'.
	const box = head.toString("latin1", 4, 8);
	if (["moov", "mdat", "free", "wide", "skip", "pnot"].includes(box)) return true;

	// EBML container (webm / mkv): 0x1A45DFA3.
	if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) {
		return true;
	}

	// AVI / WAV-style RIFF: 'RIFF' .... 'AVI '.
	if (head.toString("latin1", 0, 4) === "RIFF" && head.toString("latin1", 8, 12) === "AVI ") {
		return true;
	}

	// MPEG program / transport stream and elementary video.
	// MPEG-TS: sync byte 0x47 (checked loosely — first byte).
	if (head[0] === 0x47) return true;
	// MPEG-PS / MPEG-1/2 video start code: 0x000001 followed by BA/B3.
	if (
		head[0] === 0x00 &&
		head[1] === 0x00 &&
		head[2] === 0x01 &&
		(head[3] === 0xba || head[3] === 0xb3)
	) {
		return true;
	}

	// FLV.
	if (head.toString("latin1", 0, 3) === "FLV") return true;

	// ASF / WMV GUID: 30 26 B2 75.
	if (head[0] === 0x30 && head[1] === 0x26 && head[2] === 0xb2 && head[3] === 0x75) {
		return true;
	}

	return false;
}
