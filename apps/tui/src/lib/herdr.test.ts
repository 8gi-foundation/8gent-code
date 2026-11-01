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
import { withoutBangLines } from "./bang-command";
import { HERDR_ID_PREFIX, parseSnapshot, runHerdrCommand, stripTerminalText } from "./herdr";

// The snapshot shape herdr 0.9.3 prints for `herdr api snapshot` (src/cli/api.rs, schema SessionSnapshot).
const SNAPSHOT = JSON.stringify({
	id: "cli:api:snapshot",
	result: {
		type: "session_snapshot",
		snapshot: {
			version: "0.9.3",
			protocol: 22,
			workspaces: [
				{ workspace_id: "w1", label: "termiux" },
				{ workspace_id: "w2", label: "kali" },
			],
			tabs: [
				{ tab_id: "t1", workspace_id: "w1", label: "main" },
				{ tab_id: "t2", workspace_id: "w2", label: "main" },
			],
			panes: [
				{ pane_id: "w1:p1", workspace_id: "w1", tab_id: "t1", agent: null, label: "8gent" },
				{
					pane_id: "w1:p2",
					workspace_id: "w1",
					tab_id: "t1",
					agent: "pi",
					display_agent: "pi",
					label: null,
					title: "pi \x1b]0;evil\x07",
				},
				{ pane_id: "w2:p1", workspace_id: "w2", tab_id: "t2", agent: null, cwd: "/data/home" },
			],
			layouts: [],
			agents: [],
		},
	},
});

let root: string;
let bin: string;
let log: string;
let cwd: string;

function env(extra: Record<string, string> = {}): Record<string, string> {
	return {
		HERDR_ENV: "1",
		HERDR_PANE_ID: "w1:p1",
		PATH: `${bin}:/usr/bin:/bin`,
		HERDR_FAKE_LOG: log,
		...extra,
	};
}

beforeAll(() => {
	// Outside the working tree, so the outside-the-folder PATH rule (#4769) keeps it.
	root = mkdtempSync(join(tmpdir(), "herdr-fake-"));
	bin = join(root, "bin");
	cwd = join(root, "project");
	mkdirSync(bin);
	mkdirSync(cwd);
	log = join(root, "argv.log");
	writeFileSync(join(root, "snapshot.json"), SNAPSHOT);
	writeFileSync(
		join(bin, "herdr"),
		`#!/bin/sh
for a in "$@"; do printf '%s|' "$a" >> "$HERDR_FAKE_LOG"; done; echo >> "$HERDR_FAKE_LOG"
if [ "$HERDR_FAKE_MODE" = fail ]; then echo '{"id":"x","error":{"code":"server_not_running","message":"no herdr server is running"}}' >&2; exit 1; fi
if [ "$1 $2" = "api snapshot" ]; then cat "${root}/snapshot.json"; exit 0; fi
if [ "$1 $2" = "pane read" ]; then printf 'pi> \\033[32mready\\033[0m\\r\\nkey: \\033]8;;http://x\\007link\\033]8;;\\007 done\\n'; exit 0; fi
exit 2
`,
	);
	chmodSync(join(bin, "herdr"), 0o755);
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

function calls(): string[] {
	if (!existsSync(log)) return [];
	return readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
}

describe("/herdr (read-only, #4773)", () => {
	test("lists the panes beside this one with the tool herdr detected", async () => {
		const out = await runHerdrCommand([], { env: env(), cwd });
		expect(out).toContain("herdr panes beside this one (2):");
		expect(out).toContain("w1:p2  termiux/main  pi");
		expect(out).toContain("w2:p1  kali/main  shell  /data/home");
		expect(out).not.toContain("w1:p1");
		expect(out).not.toContain("\x1b");
		expect(out).not.toContain("evil");
		expect(calls().at(-1)).toBe("api|snapshot|");
	});

	test("shows a pane's recent output, escapes removed, labelled untrusted, lines capped", async () => {
		const out = await runHerdrCommand(["w1:p2", "9999"], { env: env(), cwd });
		expect(out.split("\n")[0]).toStartWith(
			"UNTRUSTED OUTPUT from herdr pane w1:p2 (last 200 lines)",
		);
		expect(out).toContain("pi> ready\nkey: link done");
		expect(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(out)).toBeFalse();
		expect(calls().at(-1)).toBe("pane|read|w1:p2|--source|recent|--lines|200|");
	});

	test("never sends: no run, send-text or send-keys in any call", async () => {
		await runHerdrCommand([], { env: env(), cwd });
		await runHerdrCommand(["w2:p1"], { env: env(), cwd });
		for (const c of calls()) expect(c).toMatch(/^(api\|snapshot|pane\|read)\|/);
	});

	test("a pane id that looks like a flag or carries shell text is refused before herdr runs", async () => {
		const before = calls().length;
		expect(await runHerdrCommand(["--help"], { env: env(), cwd })).toContain(
			"is not a herdr pane id",
		);
		expect(await runHerdrCommand(["p1;rm -rf ~"], { env: env(), cwd })).toContain(
			"is not a herdr pane id",
		);
		expect(await runHerdrCommand(["p_pi"], { env: env(), cwd })).toContain(
			"is not a herdr pane id",
		);
		expect(calls().length).toBe(before);
	});

	test("a line count that is not a whole number is refused before herdr runs", async () => {
		const before = calls().length;
		for (const bad of ["12abc", "-5", "1e3", "0x10", "99999"])
			expect(await runHerdrCommand(["w1:p2", bad], { env: env(), cwd })).toContain(
				"is not a line count",
			);
		expect(calls().length).toBe(before);
	});

	test("a pane read is never saved with the session", () => {
		const kept = withoutBangLines([
			{ id: "user-1" },
			{ id: `${HERDR_ID_PREFIX}1` },
			{ id: "system-2" },
		]);
		expect(kept.map((m) => m.id)).toEqual(["user-1", "system-2"]);
	});

	test("herdr erroring is one plain line, never a throw", async () => {
		const out = await runHerdrCommand([], { env: env({ HERDR_FAKE_MODE: "fail" }), cwd });
		expect(out).toBe("herdr failed: no herdr server is running");
	});

	test("outside herdr, or herdr absent, is one plain line", async () => {
		expect(await runHerdrCommand([], { env: { PATH: bin }, cwd })).toStartWith(
			"Not inside a herdr pane",
		);
		const absent = await runHerdrCommand([], { env: env({ PATH: "/usr/bin:/bin" }), cwd });
		expect(absent).toStartWith("herdr is not on PATH");
		expect(absent.includes("\n")).toBeFalse();
	});

	test("a herdr planted inside the project is not run (#4769)", async () => {
		const planted = join(cwd, "bin");
		mkdirSync(planted, { recursive: true });
		writeFileSync(join(planted, "herdr"), `#!/bin/sh\necho planted > "${root}/planted"\n`);
		chmodSync(join(planted, "herdr"), 0o755);
		const out = await runHerdrCommand([], { env: env({ PATH: `${planted}:bin:.:/usr/bin` }), cwd });
		expect(out).toStartWith("herdr is not on PATH");
		expect(existsSync(join(root, "planted"))).toBeFalse();
	});

	test("parseSnapshot rejects output that is not a session snapshot", () => {
		expect(parseSnapshot("not json")).toBeNull();
		expect(parseSnapshot(JSON.stringify({ id: "x", result: { type: "pong" } }))).toBeNull();
		expect(stripTerminalText("a\x1b[1;31mb\x1b7c\x9b2Kd")).toBe("abcd");
	});
});
