/** speak must reach the local agent: executor case, local allowlist, prompt (#3596). */
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDirs, tempDir } from "../../../tests/temp-dirs";
import { buildToolCatalogSegment } from "../prompts/system-prompt";
import { ToolExecutor } from "../tools";

afterAll(cleanupTempDirs);

describe("speak is wired into the local agent", () => {
	test("ToolExecutor runs speak and returns path and duration", async () => {
		const root = tempDir("speak-wiring-");
		const stub = join(root, "st");
		writeFileSync(
			stub,
			`#!/usr/bin/env bash
python3 - "$4" <<'PY'
import sys,struct
d=b'\\0\\0'*8000
open(sys.argv[1],'wb').write(b'RIFF'+struct.pack('<I',36+len(d))+b'WAVEfmt '+struct.pack('<IHHIIHH',16,1,1,8000,16000,2,16)+b'data'+struct.pack('<I',len(d))+d)
PY
`,
		);
		chmodSync(stub, 0o755);
		const saved = { h: process.env.HOME, s: process.env.EIGHT_SUPERTONIC_BIN };
		process.env.HOME = root;
		process.env.EIGHT_SUPERTONIC_BIN = stub;
		try {
			mkdirSync(join(root, "work"));
			const ex = new ToolExecutor(join(root, "work"));
			const out = JSON.parse(await ex.execute("speak", { text: "hello", voice: "Rishi", out: "w.wav" }));
			expect(out.durationSec).toBe(1);
			expect(existsSync(out.path)).toBe(true);
		} finally {
			process.env.HOME = saved.h;
			if (saved.s === undefined) delete process.env.EIGHT_SUPERTONIC_BIN;
			else process.env.EIGHT_SUPERTONIC_BIN = saved.s;
		}
	});

	test("local core allowlist includes speak and the prompt tells narration to use it", async () => {
		const src = await Bun.file(join(import.meta.dir, "..", "agent.ts")).text();
		const core = src.slice(src.indexOf("const CORE_TOOLS = ["), src.indexOf("const CORE_TOOLS = [") + 1200);
		expect(core).toContain('"speak"');
		const cat = buildToolCatalogSegment({ concise: true, omit: [] });
		expect(cat).toContain("speak");
		expect(cat).toMatch(/Never use espeak or say/);
	});
});
