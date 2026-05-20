/**
 * Test fixture helpers — written at runtime into a temp dir.
 *
 * Video files are gitignored repo-wide (`*.mp4`), so the test fixtures are
 * generated on demand rather than committed. The mp4 fixture is a minimal
 * file with a valid ISO base media `ftyp` box so the container sniff in
 * video-path.ts accepts it; it is NOT a decodable video, which is fine —
 * every test runs against the fake sidecar, not the real Marlin decoder.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Minimal bytes that satisfy `matchesVideoMagic`: a 'ftyp' mp4 box. */
const MP4_MAGIC = Buffer.from(
	// box size (24) + 'ftyp' + 'mp42' major brand + minor version + 'mp42isom'
	[
		0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32, 0x00, 0x00, 0x00, 0x00,
		0x6d, 0x70, 0x34, 0x32, 0x69, 0x73, 0x6f, 0x6d,
	],
);

export interface VideoFixtures {
	dir: string;
	sampleMp4: string;
	notVideo: string;
}

/** Create a fresh temp directory with a sample mp4 and a non-video file. */
export function makeVideoFixtures(): VideoFixtures {
	const dir = mkdtempSync(join(tmpdir(), "marlin-fixtures-"));
	const sampleMp4 = join(dir, "sample.mp4");
	const notVideo = join(dir, "notvideo.txt");
	writeFileSync(sampleMp4, MP4_MAGIC);
	writeFileSync(notVideo, "this is plain text, not a video");
	return { dir, sampleMp4, notVideo };
}
