import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRunArgs, buildSplitArgs, newPaneId, openInHerdrPane, shellQuote } from "./herdr-open";

let root: string;
let bin: string;
let log: string;
let cwd: string;

const env = (extra: Record<string, string> = {}) => ({
	HERDR_ENV: "1",
	HERDR_PANE_ID: "w1:p1",
	PATH: `${bin}:/usr/bin:/bin`,
	HERDR_FAKE_LOG: log,
	...extra,
});
const calls = () =>
	existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : [];

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "herdr-open-"));
	bin = join(root, "bin");
	cwd = join(root, "project");
	mkdirSync(bin);
	mkdirSync(cwd);
	log = join(root, "argv.log");
	writeFileSync(
		join(bin, "herdr"),
		`#!/bin/sh
for a in "$@"; do printf '%s|' "$a" >> "$HERDR_FAKE_LOG"; done; echo >> "$HERDR_FAKE_LOG"
if [ "$HERDR_FAKE_MODE" = fail ]; then echo '{"id":"x","error":{"code":"server_not_running","message":"no herdr server is running"}}' >&2; exit 1; fi
if [ "$1 $2" = "pane split" ]; then echo '{"id":"x","result":{"type":"pane_info","pane":{"pane_id":"w1:p2"}}}'; exit 0; fi
if [ "$1 $2" = "pane run" ]; then exit 0; fi
exit 2
`,
	);
	chmodSync(join(bin, "herdr"), 0o755);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("argv builders", () => {
	test("split targets the calling pane, to the right, in the project folder", () => {
		expect(buildSplitArgs("w1:p1", "/p")).toEqual([
			"pane",
			"split",
			"--pane",
			"w1:p1",
			"--direction",
			"right",
			"--cwd",
			"/p",
			"--focus",
		]);
	});
	test("a pane id that is not a herdr id falls back to --current, never reaches argv", () => {
		expect(buildSplitArgs("--help", "/p")).toContain("--current");
		expect(buildSplitArgs("--help", "/p")).not.toContain("--help");
		expect(buildSplitArgs(undefined, "/p")).toContain("--current");
	});
	test("run quotes the path as one shell word", () => {
		expect(buildRunArgs("w1:p2", "/data/bin/pi")).toEqual([
			"pane",
			"run",
			"w1:p2",
			"'/data/bin/pi'",
		]);
		expect(shellQuote("/a b/it's;rm")).toBe(`'/a b/it'\\''s;rm'`);
	});
	test("newPaneId accepts only a herdr pane id", () => {
		expect(newPaneId('{"result":{"pane":{"pane_id":"w3:p9"}}}')).toBe("w3:p9");
		expect(newPaneId('{"result":{"pane":{"pane_id":"x;ls"}}}')).toBeNull();
		expect(newPaneId("nope")).toBeNull();
	});
});

describe("openInHerdrPane", () => {
	test("splits then runs the preset by absolute path, and says where", async () => {
		const r = await openInHerdrPane("pi", "/data/bin/pi", { env: env(), cwd });
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.message).toContain("Opened pi in a herdr pane beside 8gent");
		const c = calls();
		expect(c.at(-2)).toBe(`pane|split|--pane|w1:p1|--direction|right|--cwd|${cwd}|--focus|`);
		expect(c.at(-1)).toBe("pane|run|w1:p2|'/data/bin/pi'|");
	});
	test("a shell opens with a split and no run", async () => {
		const before = calls().length;
		const r = await openInHerdrPane("Terminal (zsh)", null, { env: env(), cwd });
		expect(r.ok).toBe(true);
		expect(calls().length - before).toBe(1);
	});
	test("a bare command name is refused before herdr runs", async () => {
		const before = calls().length;
		const r = await openInHerdrPane("pi", "pi", { env: env(), cwd });
		expect(r.ok).toBe(false);
		expect(calls().length).toBe(before);
	});
	test("outside herdr, or herdr failing, gives a reason and runs nothing further", async () => {
		expect((await openInHerdrPane("pi", "/x/pi", { env: env({ HERDR_ENV: "0" }), cwd })).ok).toBe(
			false,
		);
		const before = calls().length;
		const r = await openInHerdrPane("pi", "/x/pi", { env: env({ HERDR_FAKE_MODE: "fail" }), cwd });
		expect(r).toEqual({ ok: false, reason: "herdr failed: no herdr server is running" });
		expect(calls().length - before).toBe(1);
	});
});
