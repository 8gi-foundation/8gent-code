/** An 8gent speaks in its tab voice; an explicit voice wins; unknown names are refused. */
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDirs, tempDir } from "../../../tests/temp-dirs";
import { SPEAK_VOICES, createTabVoices } from "../../tools/speak";
import { ToolExecutor } from "../tools";

afterAll(cleanupTempDirs);

const posixTest = process.platform === "win32" ? test.skip : test;

/** Stub Supertonic that logs the --voice id it was given. */
function fixture() {
	const root = tempDir("speak-agent-voice-");
	const work = join(root, "work");
	mkdirSync(work);
	const stub = join(root, "st");
	const log = join(root, "voice.txt");
	writeFileSync(
		stub,
		`#!/usr/bin/env bash
OUT="$3"
while [ $# -gt 0 ]; do [ "$1" = --voice ] && printf '%s' "$2" > "${log}"; shift; done
python3 - "$OUT" <<'PY'
import sys,struct
d=b'\\0\\0'*8000
open(sys.argv[1],'wb').write(b'RIFF'+struct.pack('<I',36+len(d))+b'WAVEfmt '+struct.pack('<IHHIIHH',16,1,1,8000,16000,2,16)+b'data'+struct.pack('<I',len(d))+d)
PY
`,
	);
	chmodSync(stub, 0o755);
	process.env.EIGHT_SUPERTONIC_BIN = stub;
	process.env.EIGHT_KITTEN_PY = "/nonexistent";
	return { work, spoken: () => readFileSync(log, "utf8") };
}

describe("per-tab speak voice", () => {
	posixTest("tab voice is used when the call names none", async () => {
		const { work, spoken } = fixture();
		const ex = new ToolExecutor(work, "primary", undefined, { tabVoice: "Karen" });
		const out = JSON.parse(await ex.execute("speak", { text: "hi", out: "a.wav" }));
		expect(out.voice).toBe("Karen");
		expect(spoken()).toBe("F3");
	});

	posixTest("an explicit voice argument wins over the tab voice", async () => {
		const { work, spoken } = fixture();
		const ex = new ToolExecutor(work, "primary", undefined, { tabVoice: "Karen" });
		const out = JSON.parse(await ex.execute("speak", { text: "hi", voice: "Rishi", out: "b.wav" }));
		expect(out.voice).toBe("Rishi");
		expect(spoken()).toBe("M3");
	});

	posixTest("unset falls back to Daniel", async () => {
		const { work, spoken } = fixture();
		const out = JSON.parse(
			await new ToolExecutor(work).execute("speak", { text: "hi", out: "c.wav" }),
		);
		expect(out.voice).toBe("Daniel");
		expect(spoken()).toBe("M2");
	});

	test("a configured name outside the allowlist is rejected", async () => {
		const { work } = fixture();
		const ex = new ToolExecutor(work, "primary", undefined, { tabVoice: "../etc/passwd" });
		const r = await ex.execute("speak", { text: "hi", out: "d.wav" });
		expect(r).toContain('unknown voice "../etc/passwd"');
	});
});

describe("tab voice assignment", () => {
	const names = Object.keys(SPEAK_VOICES);

	test("two tabs get different voices, in allowlist order", () => {
		const v = createTabVoices();
		expect(v.assign("t1")).toBe(names[0]);
		expect(v.assign("t2")).toBe(names[1]);
		expect(v.assign("t1")).not.toBe(v.assign("t2"));
	});

	test("deterministic: same sequence, same voices; stable for a tab's life", () => {
		const run = () => {
			const v = createTabVoices();
			return ["a", "b", "c", "a", "b"].map((t) => v.assign(t));
		};
		expect(run()).toEqual(run());
		expect(run()[3]).toBe(run()[0]);
	});

	test("wraps around past the last voice", () => {
		const v = createTabVoices();
		const got = Array.from({ length: names.length + 2 }, (_, i) => v.assign(`t${i}`));
		expect(got[names.length]).toBe(names[0]);
		expect(got[names.length + 1]).toBe(names[1]);
	});

	test("a released slot is reused by the next new tab", () => {
		const v = createTabVoices();
		v.assign("a");
		const b = v.assign("b");
		v.assign("c");
		v.release("b");
		expect(v.assign("d")).toBe(b);
	});

	test("every assigned voice passes the allowlist", () => {
		const v = createTabVoices();
		for (let i = 0; i < 40; i++) expect(SPEAK_VOICES[v.assign(`t${i}`)]).toBeDefined();
	});
});
