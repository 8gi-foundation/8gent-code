import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isTtsActive } from "../hooks/ptt-state.js";
import { speakWithKittenTts } from "./LiveFocalStrip.js";

describe("speakWithKittenTts marks speech for push-to-talk", () => {
	test("tracker is active while the spawned voice runs, and clears when it exits", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kitten-say-"));
		try {
			const bin = join(dir, "kittentts-say");
			writeFileSync(bin, "#!/bin/sh\nsleep 0.4\n");
			chmodSync(bin, 0o755);
			expect(isTtsActive()).toBe(false);
			speakWithKittenTts("goal done", bin);
			expect(isTtsActive()).toBe(true);
			for (let i = 0; i < 40 && isTtsActive(); i++) await new Promise((r) => setTimeout(r, 50));
			expect(isTtsActive()).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
