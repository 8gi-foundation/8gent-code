/**
 * Recording linkage (issue #2869): a bake that produces an MP4 must write
 * WHICH file it produced back into the huddle's manifest.json - filename,
 * sha256 of the bytes, bake timestamp - so replay resolves by reference
 * instead of the phone re-deriving a truncated topic slug and comparing
 * close times.
 *
 * Pinned here:
 *   * writeRecordingToManifest writes {file, sha256, bakedAt} to disk, the
 *     filename is a BARE basename, and the hash matches an independently
 *     computed sha256 of the same bytes;
 *   * backfill safety: a manifest that never baked an MP4 (zero turns) has
 *     NO recording key at all - absence, not null, not a placeholder;
 *   * the real path: a full bakeHuddle run (Chrome + ffmpeg, skipped when
 *     either is missing) leaves manifest.json linking exactly the MP4 that
 *     landed in the creative dir.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { spawnSync } from "node:child_process";
import {
	bakeHuddle,
	findChrome,
	huddleDir,
	sha256File,
	writeRecordingToManifest,
	THEME_VERSION,
	type BakedTurn,
	type HuddleManifest,
} from "../bake";

function manifestOf(huddleId: string, turns: BakedTurn[]): HuddleManifest {
	return {
		huddleId,
		channelId: "chan_test",
		topic: "recording linkage",
		themeVersion: THEME_VERSION,
		openedAt: 1_700_000_000_000,
		closedAt: 1_700_000_060_000,
		turns,
	};
}

function turn(index: number): BakedTurn {
	return {
		turnId: `t${index}`,
		index,
		holder: "agent:8TO",
		code: "8TO",
		name: "Rishi",
		voice: "M1",
		spec: { layout: "bullets", heading: "Link the recording", bullets: ["by reference, not slug"] },
		sha256: "0".repeat(64),
		text: "Link the recording by reference.",
		audioPath: null,
		audioOffsetMs: 0,
		durationMs: 400,
		hasAsserted: false,
		assertedFields: [],
	};
}

const ffmpegPresent = spawnSync("ffmpeg", ["-version"], { encoding: "utf8" }).status === 0;

// Real huddle dirs this suite creates under ~/.8gent/huddles - removed at the
// end so a test run leaves no archive rows behind on James's machine.
const testHuddleIds: string[] = [];
// Creative MP4s the integration bake produces - removed for the same reason:
// the phone's gallery is a REAL surface and must not accumulate test artifacts.
const creativeOutputs: string[] = [];

afterAll(() => {
	for (const id of testHuddleIds) rmSync(huddleDir(id), { recursive: true, force: true });
	for (const p of creativeOutputs) rmSync(p, { force: true });
});

describe("writeRecordingToManifest", () => {
	it("writes file (bare basename), sha256 of the bytes, and bakedAt to disk", () => {
		const dir = mkdtempSync(join(tmpdir(), "bake-rec-"));
		const video = join(dir, "huddle-recording-linkage-20260811-120000.mp4");
		writeFileSync(video, "not a real mp4, but real bytes");
		const manifestPath = join(dir, "manifest.json");
		const manifest = manifestOf("hud_reclink1", []);
		writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

		const before = Date.now();
		const rec = writeRecordingToManifest(manifestPath, manifest, video);

		expect(rec.file).toBe("huddle-recording-linkage-20260811-120000.mp4");
		expect(rec.file.includes("/")).toBe(false);
		const independent = createHash("sha256").update(readFileSync(video)).digest("hex");
		expect(rec.sha256).toBe(independent);
		expect(rec.bakedAt).toBeGreaterThanOrEqual(before);

		// The write is ON DISK, not just on the in-memory object.
		const onDisk = JSON.parse(readFileSync(manifestPath, "utf8"));
		expect(onDisk.recording).toEqual(rec);
		// And the rest of the manifest survived the rewrite intact.
		expect(onDisk.huddleId).toBe("hud_reclink1");
		expect(onDisk.turns).toEqual([]);
		rmSync(dir, { recursive: true, force: true });
	});

	it("sha256File matches node:crypto on the same bytes", () => {
		const dir = mkdtempSync(join(tmpdir(), "bake-sha-"));
		const p = join(dir, "bytes.bin");
		writeFileSync(p, Buffer.from([0, 1, 2, 250, 251, 252]));
		expect(sha256File(p)).toBe(createHash("sha256").update(readFileSync(p)).digest("hex"));
		rmSync(dir, { recursive: true, force: true });
	});
});

describe("backfill safety", () => {
	it("a bake that produces no MP4 leaves manifest.json with NO recording key", () => {
		const id = `test_rec_none_${process.pid}`;
		testHuddleIds.push(id);
		const result = bakeHuddle(manifestOf(id, []), "20260811-000000");
		expect(result.videoPath).toBeNull();
		expect(result.videoError).toBe("no turns to bake");
		expect(result.recording).toBeUndefined();
		const onDisk = JSON.parse(readFileSync(result.manifestPath, "utf8"));
		expect("recording" in onDisk).toBe(false);
	});
});

describe("the real path: full bake links exactly the file it produced", () => {
	// Chrome and ffmpeg are the bake's own preconditions; without either the
	// bake honestly reports videoError, so there is no linkage to test.
	it.skipIf(!findChrome() || !ffmpegPresent)(
		"manifest.json gains recording {file, sha256, bakedAt} matching the creative MP4",
		() => {
			const id = `test_rec_real_${process.pid}`;
			testHuddleIds.push(id);
			const result = bakeHuddle(manifestOf(id, [turn(0)]), "19990811-000000");
			expect(result.videoError).toBeUndefined();
			expect(result.videoPath).not.toBeNull();
			const videoPath = result.videoPath as string;
			creativeOutputs.push(videoPath);
			expect(existsSync(videoPath)).toBe(true);

			const onDisk = JSON.parse(readFileSync(result.manifestPath, "utf8"));
			expect(onDisk.recording.file).toBe(basename(videoPath));
			expect(onDisk.recording.sha256).toBe(
				createHash("sha256").update(readFileSync(videoPath)).digest("hex"),
			);
			expect(typeof onDisk.recording.bakedAt).toBe("number");
			expect(result.recording).toEqual(onDisk.recording);
		},
		120_000,
	);
});
