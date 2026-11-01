import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FetchLike } from "./self-update";
import {
	CHECK_INTERVAL_MS,
	type NoticeDeps,
	type NoticeState,
	maybeUpdateNotice,
	noticeText,
	realNoticeDeps,
	updateCheckDisabled,
} from "./update-notice";
import {
	RELAUNCH_EXIT_CODE,
	UPDATE_NOTE_ENV,
	consumeResumeRequest,
	relaunchCommand,
	writeResumeRequest,
} from "./update-resume";

function deps(over: Partial<NoticeDeps> & { state?: NoticeState | null; at?: number } = {}) {
	let state: NoticeState | null = over.state ?? null;
	const calls = { check: 0, writes: [] as NoticeState[] };
	const d: NoticeDeps = {
		now: () => over.at ?? 1_000_000_000_000,
		disabled: () => false,
		readState: () => state,
		writeState: (s) => {
			state = s;
			calls.writes.push(s);
		},
		check: async () => {
			calls.check++;
			return { from: "abc1234", to: "def5678" };
		},
		current: async () => "abc1234",
		...over,
	};
	return { d, calls };
}

describe("update notice", () => {
	test("the text is exactly the one line James asked for", () => {
		expect(noticeText("abc123", "def456")).toBe(
			"Update available (abc123 -> def456). Run 8gent update, or type /update.",
		);
	});

	test("first run checks, shows the line, and records the time", async () => {
		const t = deps();
		expect(await maybeUpdateNotice(t.d)).toBe(noticeText("abc1234", "def5678"));
		expect(t.calls.check).toBe(1);
		expect(t.calls.writes[0].checkedAt).toBe(1_000_000_000_000);
	});

	test("24 h throttle: a second start within 24 h does not check again but still shows the cached notice", async () => {
		const at = 1_000_000_000_000;
		const t = deps({
			state: {
				checkedAt: at - CHECK_INTERVAL_MS + 60_000,
				available: { from: "abc1234", to: "def5678", label: noticeText("abc1234", "def5678") },
			},
		});
		expect(await maybeUpdateNotice(t.d)).toBe(noticeText("abc1234", "def5678"));
		expect(t.calls.check).toBe(0);
		expect(t.calls.writes).toEqual([]);
	});

	test("a cached notice is dropped once the install has moved on", async () => {
		const t = deps({
			state: {
				checkedAt: 1_000_000_000_000 - 1000,
				available: { from: "abc1234", to: "def5678", label: "x" },
			},
			current: async () => "def5678",
		});
		expect(await maybeUpdateNotice(t.d)).toBeNull();
	});

	test("a check older than 24 h runs again", async () => {
		const t = deps({ state: { checkedAt: 1_000_000_000_000 - CHECK_INTERVAL_MS - 1 } });
		await maybeUpdateNotice(t.d);
		expect(t.calls.check).toBe(1);
	});

	test("a clock that went backwards does not pin the throttle forever", async () => {
		const t = deps({ state: { checkedAt: 1_000_000_000_000 + 5 * CHECK_INTERVAL_MS } });
		await maybeUpdateNotice(t.d);
		expect(t.calls.check).toBe(1);
	});

	test("offline or any error is silent and still counts as a check", async () => {
		const t = deps({
			check: async () => {
				throw new Error("getaddrinfo ENOTFOUND");
			},
		});
		expect(await maybeUpdateNotice(t.d)).toBeNull();
		expect(t.calls.writes.length).toBe(1);
		const t2 = deps({
			readState: () => {
				throw new Error("disk");
			},
		});
		expect(await maybeUpdateNotice(t2.d)).toBeNull();
	});

	test("up to date shows nothing", async () => {
		const t = deps({ check: async () => null });
		expect(await maybeUpdateNotice(t.d)).toBeNull();
	});

	test("EIGHT_NO_UPDATE_CHECK=1 turns it off before anything runs", async () => {
		expect(updateCheckDisabled({ EIGHT_NO_UPDATE_CHECK: "1" })).toBe(true);
		expect(updateCheckDisabled({ EIGHT_NO_UPDATE_CHECK: "0" })).toBe(false);
		expect(updateCheckDisabled({ EIGHT_NO_UPDATE_CHECK: "" })).toBe(false);
		expect(updateCheckDisabled({})).toBe(false);
		const t = deps({ disabled: () => updateCheckDisabled({ EIGHT_NO_UPDATE_CHECK: "1" }) });
		expect(await maybeUpdateNotice(t.d)).toBeNull();
		expect(t.calls.check).toBe(0);
		expect(t.calls.writes).toEqual([]);
	});

	test("settings.json updateCheck:false turns it off", () => {
		const dir = mkdtempSync(join(tmpdir(), "notice-set-"));
		try {
			const f = join(dir, "settings.json");
			writeFileSync(f, JSON.stringify({ updateCheck: false }));
			expect(updateCheckDisabled({}, f)).toBe(true);
			writeFileSync(f, "{not json");
			expect(updateCheckDisabled({}, f)).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("real wiring writes the state file under the 8gent data dir and is silent when the checkout cannot be found", async () => {
		const home = mkdtempSync(join(tmpdir(), "notice-home-"));
		try {
			// Hermetic: a nonexistent path resolves to the npm channel, which would read the
			// live registry. Inject a fetch that fails offline so no test touches the network.
			const offline = async () => {
				throw new Error("offline");
			};
			const w = realNoticeDeps({
				fetchImpl: offline as unknown as FetchLike,
				currentVersion: "0.18.0",
				modulePath: "file:///nonexistent-root/8gent-code/bin/8gent.ts",
				embedded: false,
				env: { EIGHT_HOME: home, PATH: "/usr/bin", EIGHT_UPDATE_CHECK: "1" },
				platform: "linux",
				now: () => 5,
			});
			expect(await maybeUpdateNotice(w)).toBeNull();
			expect(
				JSON.parse(readFileSync(join(home, ".8gent", "update-check.json"), "utf8")).checkedAt,
			).toBe(5);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
});

describe("resume record and relaunch command", () => {
	test("write, consume once, and the record is gone", () => {
		const home = mkdtempSync(join(tmpdir(), "resume-"));
		try {
			const env = { EIGHT_HOME: home };
			writeResumeRequest(
				{ sessionId: "sess_abc123", note: "Updated to def5678, resumed your session." },
				env,
			);
			expect(consumeResumeRequest(env)).toEqual({
				sessionId: "sess_abc123",
				note: "Updated to def5678, resumed your session.",
			});
			expect(consumeResumeRequest(env)).toBeNull();
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("a session id that is not id-shaped is dropped, never passed to a command line", () => {
		const home = mkdtempSync(join(tmpdir(), "resume-"));
		try {
			const env = { EIGHT_HOME: home };
			writeResumeRequest({ sessionId: "x; whoami", note: "n" }, env);
			expect(consumeResumeRequest(env)?.sessionId).toBeUndefined();
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("source install relaunches the same runtime and entry with --resume=<id> and the note", () => {
		const c = relaunchCommand({
			embedded: false,
			execPath: "/usr/bin/bun",
			entryScript: "/w/bin/8gent.ts",
			req: { sessionId: "s1", note: "hi" },
			env: { A: "1" },
		});
		expect(c.command).toBe("/usr/bin/bun");
		expect(c.args).toEqual(["/w/bin/8gent.ts", "--resume=s1"]);
		expect(c.env[UPDATE_NOTE_ENV]).toBe("hi");
	});

	test("a compiled binary relaunches itself; no session means a plain start", () => {
		expect(
			relaunchCommand({
				embedded: true,
				execPath: "C:\\8gent.exe",
				entryScript: "/$bunfs/x",
				req: { sessionId: "s1", note: "n" },
			}).args,
		).toEqual(["--resume=s1"]);
		expect(
			relaunchCommand({ embedded: true, execPath: "/b/8gent", req: { note: "n" } }).args,
		).toEqual([]);
		expect(RELAUNCH_EXIT_CODE).toBe(75);
	});
});
