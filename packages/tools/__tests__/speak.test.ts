import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SPEAK_VOICES, speak, wavDurationSec } from "../speak";

let dir: string;
const saved = { ...process.env };

/** Stub engine: writes a 0.75s 8kHz mono 16-bit wav to its 4th argument. */
function stub(name: string): string {
	const p = path.join(dir, name);
	fs.writeFileSync(
		p,
		`#!/usr/bin/env bash
python3 - "$4" <<'PY'
import sys,struct
d=b'\\0\\0'*6000
open(sys.argv[1],'wb').write(b'RIFF'+struct.pack('<I',36+len(d))+b'WAVEfmt '+struct.pack('<IHHIIHH',16,1,1,8000,16000,2,16)+b'data'+struct.pack('<I',len(d))+d)
PY
`,
		{ mode: 0o755 },
	);
	return p;
}

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "speak-test-"));
	process.env.HOME = dir;
});
afterEach(() => {
	process.env = { ...saved };
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("speak", () => {
	test("Supertonic path returns wav path and duration", async () => {
		process.env.EIGHT_SUPERTONIC_BIN = stub("st");
		process.env.EIGHT_KITTEN_PY = "/nonexistent";
		const r = await speak({ text: "hello there", voice: "Rishi", out: "t.wav" });
		expect(r.engine).toBe("supertonic");
		expect(r.durationSec).toBe(0.75);
		expect(fs.existsSync(r.path)).toBe(true);
		expect(r.path.endsWith("t.wav")).toBe(true);
	});

	test("falls back to Kitten when Supertonic is missing", async () => {
		process.env.EIGHT_SUPERTONIC_BIN = "/nonexistent";
		process.env.EIGHT_KITTEN_PY = stub("py");
		const r = await speak({ text: "hello", voice: "Rishi", out: "k" });
		expect(r.engine).toBe("kitten");
		expect(r.path.endsWith("k.wav")).toBe(true);
	});

	test("fails loudly when neither engine is installed, writes nothing", async () => {
		process.env.EIGHT_SUPERTONIC_BIN = "/nonexistent";
		process.env.EIGHT_KITTEN_PY = "/nonexistent";
		await expect(speak({ text: "hi", out: "none.wav" })).rejects.toThrow(/no local neural TTS/);
		expect(fs.existsSync(path.join(dir, ".8gent", "creative", "none.wav"))).toBe(false);
	});

	test("rejects unknown voice, empty text, oversize text; strips path from out", async () => {
		await expect(speak({ text: "hi", voice: "Nobody" })).rejects.toThrow(/unknown voice/);
		await expect(speak({ text: "  " })).rejects.toThrow(/text is required/);
		await expect(speak({ text: "x".repeat(2001) })).rejects.toThrow(/cap/);
		process.env.EIGHT_SUPERTONIC_BIN = stub("st2");
		const r = await speak({ text: "hi", out: "../../etc/evil.wav" });
		expect(r.path.includes("..")).toBe(false);
		expect(path.basename(r.path)).toBe("evil.wav");
	});

	test("voice list is fixed; non-wav is rejected", () => {
		expect(Object.keys(SPEAK_VOICES)).toContain("Rishi");
		const bad = path.join(dir, "bad.wav");
		fs.writeFileSync(bad, "x".repeat(100));
		expect(() => wavDurationSec(bad)).toThrow(/RIFF/);
	});
});
