/**
 * Video path resolution + container sniff tests (VIDEO-INGESTION spec §6, §13).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { matchesVideoMagic, resolveVideoPath, sniffIsVideo } from "../video-path.js";
import { type VideoFixtures, makeVideoFixtures } from "./fixtures.js";

let fx: VideoFixtures;
beforeAll(() => {
	fx = makeVideoFixtures();
});
afterAll(() => {
	rmSync(fx.dir, { recursive: true, force: true });
});

describe("resolveVideoPath", () => {
	test("resolves an existing absolute video path", () => {
		const r = resolveVideoPath(fx.sampleMp4);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.absolutePath).toContain("sample.mp4");
	});

	test("resolves a relative path against cwd", () => {
		const r = resolveVideoPath("sample.mp4", fx.dir);
		expect(r.ok).toBe(true);
	});

	test("rejects an empty path", () => {
		const r = resolveVideoPath("");
		expect(r.ok).toBe(false);
	});

	test("rejects a NUL byte in the path", () => {
		const r = resolveVideoPath("foo\0bar.mp4");
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toContain("NUL");
	});

	test("rejects a missing file", () => {
		const r = resolveVideoPath(join(fx.dir, "does-not-exist.mp4"));
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toContain("not found");
	});

	test("rejects a relative path that escapes the workspace via traversal", () => {
		// cwd is the fixtures dir; '../../../etc/hosts' escapes it.
		const r = resolveVideoPath("../../../../../../etc/hosts", fx.dir);
		expect(r.ok).toBe(false);
	});

	test("rejects a relative symlink that escapes the workspace root", () => {
		const root = mkdtempSync(join(tmpdir(), "marlin-root-"));
		const outside = mkdtempSync(join(tmpdir(), "marlin-outside-"));
		const secret = join(outside, "secret.mp4");
		writeFileSync(secret, Buffer.from([0, 0, 0, 0x18]));
		const link = join(root, "escape.mp4");
		symlinkSync(secret, link);
		// A RELATIVE path through the escaping symlink is rejected.
		const r = resolveVideoPath("escape.mp4", root);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toContain("escapes");
	});

	test("rejects a directory", () => {
		const r = resolveVideoPath(fx.dir);
		expect(r.ok).toBe(false);
	});
});

describe("matchesVideoMagic", () => {
	test("recognizes an ISO base media (mp4) ftyp box", () => {
		const head = Buffer.from("0000001866747970", "hex"); // .... f t y p
		const full = Buffer.concat([head, Buffer.alloc(8)]);
		expect(matchesVideoMagic(full)).toBe(true);
	});

	test("recognizes an EBML (webm/mkv) header", () => {
		const head = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, 0]);
		expect(matchesVideoMagic(head)).toBe(true);
	});

	test("recognizes a RIFF AVI header", () => {
		const head = Buffer.from("RIFF\0\0\0\0AVI \0\0\0\0", "latin1");
		expect(matchesVideoMagic(head)).toBe(true);
	});

	test("rejects plain text", () => {
		const head = Buffer.from("this is plain text", "latin1").subarray(0, 16);
		expect(matchesVideoMagic(head)).toBe(false);
	});

	test("rejects a too-short buffer", () => {
		expect(matchesVideoMagic(Buffer.alloc(4))).toBe(false);
	});
});

describe("sniffIsVideo", () => {
	test("accepts the mp4 fixture by magic bytes", () => {
		expect(sniffIsVideo(fx.sampleMp4)).toBe(true);
	});

	test("rejects a text file even with no extension hint", () => {
		expect(sniffIsVideo(fx.notVideo)).toBe(false);
	});

	test("rejects a non-existent file", () => {
		expect(sniffIsVideo(join(fx.dir, "nope.mp4"))).toBe(false);
	});
});
