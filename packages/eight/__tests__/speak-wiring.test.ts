/** speak must reach the local agent, and write only where a write may go (#3596). */
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, symlinkSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDirs, tempDir } from "../../../tests/temp-dirs";
import { editScopeViolation } from "../../permissions/edit-guards";
import { buildToolCatalogSegment } from "../prompts/system-prompt";
import { agentTools, setToolContext } from "../../ai/tools";
import { ToolExecutor } from "../tools";

afterAll(cleanupTempDirs);

const EVIL = "hi $(touch PWNED) `touch PWNED2`; touch PWNED3 && \"q\" 'r' | cat";

/** Fixture: a stub engine that logs its text argument, plus a work dir. */
function fixture() {
	const root = tempDir("speak-wiring-");
	const work = join(root, "work");
	mkdirSync(work);
	mkdirSync(join(work, "allowed"));
	const stub = join(root, "st");
	const log = join(root, "argv.txt");
	writeFileSync(
		stub,
		`#!/usr/bin/env bash
if [ "$1" = tts ]; then OUT="$3"; [ "\${@: -2:1}" = "--" ] && echo ok > "${log}.dd"; else OUT="$4"; fi
printf '%s' "\${@: -1}" > "${log}"
if [ "$1" != tts ]; then printf '%s' "$3" > "${log}"; fi
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
	return { root, work, log };
}

describe("speak is wired into the local agent", () => {
	test("ToolExecutor runs speak inside the working directory", async () => {
		const { work } = fixture();
		const ex = new ToolExecutor(work);
		const out = JSON.parse(await ex.execute("speak", { text: "hello", voice: "Rishi", out: "w.wav" }));
		expect(out.durationSec).toBe(1);
		expect(out.path).toBe(join(work, "w.wav"));
		expect(existsSync(out.path)).toBe(true);
	});

	test("traversal and non-wav out are refused, nothing written", async () => {
		const { root, work } = fixture();
		const ex = new ToolExecutor(work);
		const t = await ex.execute("speak", { text: "hi", out: "../x.wav" });
		expect(t).toMatch(/traversal|blocked/i);
		expect(existsSync(join(root, "x.wav"))).toBe(false);
		const abs = await ex.execute("speak", { text: "hi", out: join(root, "abs.wav") });
		expect(abs).toMatch(/traversal|blocked/i);
		expect(existsSync(join(root, "abs.wav"))).toBe(false);
		const ext = await ex.execute("speak", { text: "hi", out: "a.mp3" });
		expect(ext).toMatch(/\.wav/);
		expect(existsSync(join(work, "a.mp3"))).toBe(false);
	});

	test("a scoped sub-agent cannot speak outside its scope", async () => {
		const { work } = fixture();
		const ex = new ToolExecutor(work, "child", undefined, { allowedPaths: ["allowed"] });
		const no = await ex.execute("speak", { text: "hi", out: "other.wav" });
		expect(no).toContain("SCOPE BLOCKED");
		expect(existsSync(join(work, "other.wav"))).toBe(false);
		const yes = JSON.parse(await ex.execute("speak", { text: "hi", out: "allowed/ok.wav" }));
		expect(existsSync(yes.path)).toBe(true);
		expect(editScopeViolation("speak", { text: "hi" }, work, ["allowed"])).toContain("SCOPE BLOCKED");
		expect(editScopeViolation("speak", { out: "allowed/a.wav" }, work, ["allowed"])).toBeNull();
	});

	test("a directory symlink cannot carry the write outside the workspace", async () => {
		const { root, work } = fixture();
		mkdirSync(join(root, "outside"));
		symlinkSync(join(root, "outside"), join(work, "linkdir"));
		const ex = new ToolExecutor(work);
		const r = await ex.execute("speak", { text: "hi", out: "linkdir/viadir.wav" });
		expect(r).toMatch(/traversal|blocked/i);
		expect(existsSync(join(root, "outside", "viadir.wav"))).toBe(false);
		const deep = await ex.execute("speak", { text: "hi", out: "linkdir/new/deeper.wav" });
		expect(deep).toMatch(/traversal|blocked/i);
		expect(existsSync(join(root, "outside", "new"))).toBe(false);
	});

	test("a symlinked output file is refused", async () => {
		const { root, work } = fixture();
		writeFileSync(join(root, "victim.wav"), "keep");
		symlinkSync(join(root, "victim.wav"), join(work, "link.wav"));
		const r = await new ToolExecutor(work).execute("speak", { text: "hi", out: "link.wav" });
		expect(r).toMatch(/symlink/);
		expect(readFileSync(join(root, "victim.wav"), "utf8")).toBe("keep");
	});

	test("text starting with a dash arrives after -- so it cannot be parsed as an option", async () => {
		const { work, log } = fixture();
		const ex = new ToolExecutor(work);
		await ex.execute("speak", { text: "--output=/tmp/pwn.wav --help", out: "d.wav" });
		expect(readFileSync(log, "utf8")).toBe("--output=/tmp/pwn.wav --help");
		expect(existsSync(`${log}.dd`)).toBe(true);
	});

	test("text with shell metacharacters is passed as one argv, never a shell", async () => {
		const { work, log } = fixture();
		const ex = new ToolExecutor(work);
		await ex.execute("speak", { text: EVIL, out: "m.wav" });
		expect(readFileSync(log, "utf8")).toBe(EVIL);
		for (const f of ["PWNED", "PWNED2", "PWNED3"]) expect(existsSync(join(work, f))).toBe(false);
	});

	test("native handler: same boundary (traversal, non-wav, argv) and writes inside the workdir", async () => {
		const { root, work, log } = fixture();
		setToolContext({ workingDirectory: work });
		const run = (a: Record<string, unknown>) =>
			(agentTools.speak as unknown as { execute: (a: unknown, o: unknown) => Promise<string> }).execute(a, {
				toolCallId: "t",
				messages: [],
			});
		expect(await run({ text: "hi", out: "../x.wav" })).toMatch(/traversal|blocked/i);
		expect(existsSync(join(root, "x.wav"))).toBe(false);
		expect(await run({ text: "hi", out: "a.mp3" })).toMatch(/\.wav/);
		const ok = JSON.parse(await run({ text: EVIL, out: "n.wav" }));
		expect(ok.path).toBe(join(work, "n.wav"));
		expect(readFileSync(log, "utf8")).toBe(EVIL);
		expect(existsSync(join(work, "PWNED"))).toBe(false);
	});

	test("local core allowlist includes speak and the prompt tells narration to use it", async () => {
		const src = await Bun.file(join(import.meta.dir, "..", "agent.ts")).text();
		const core = src.slice(src.indexOf("const CORE_TOOLS = ["), src.indexOf("const CORE_TOOLS = [") + 1200);
		expect(core).toContain('"speak"');
		const cat = buildToolCatalogSegment({ concise: true, omit: [] });
		expect(cat).toContain("speak");
		expect(cat).toMatch(/never espeak or say/);
	});
});
