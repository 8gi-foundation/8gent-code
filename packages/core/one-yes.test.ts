import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import {
	OWNED_PANE_MAX_HOPS,
	type ProcessLookup,
	askOneYes,
	askOneYesDetailed,
	forcedUnattended,
	inOwnedPane,
	refuseIfUnattended,
	unattended,
} from "./one-yes";

function rig(over: { tty?: boolean } = {}) {
	const input = Object.assign(new PassThrough(), { isTTY: over.tty ?? true });
	const output = Object.assign(new PassThrough(), { isTTY: over.tty ?? true });
	const logs: string[] = [];
	const ledger: Record<string, unknown>[] = [];
	return {
		input,
		output,
		logs,
		ledger,
		opts: {
			label: "test",
			env: {} as Record<string, string>,
			input,
			output,
			log: (l: string) => logs.push(l),
			record: (e: Record<string, unknown>) => ledger.push(e),
		},
	};
}

describe("one-yes resolver (#4919)", () => {
	test("timeout resolves to no, logs one line, records the ledger", async () => {
		const r = rig();
		const res = await askOneYesDetailed("Install mpv? [y/N]", { ...r.opts, timeoutMs: 30 });
		expect(res).toEqual({ answer: false, reason: "timeout" });
		expect(r.logs.length).toBe(1);
		expect(r.logs[0]).toContain("nobody answered");
		expect(r.ledger[0]?.label).toBe("test");
		expect(r.ledger[0]?.reason).toBe("timeout");
	});

	test("non-tty resolves to no at once, without waiting", async () => {
		const r = rig({ tty: false });
		const t0 = Date.now();
		const res = await askOneYesDetailed("Install mpv? [y/N]", { ...r.opts, timeoutMs: 5000 });
		expect(res).toEqual({ answer: false, reason: "no-tty" });
		expect(Date.now() - t0).toBeLessThan(1000);
		expect(r.logs.length).toBe(1);
		expect(r.ledger[0]?.reason).toBe("no-tty");
	});

	test("CI, EIGHT_UNATTENDED and EIGHT_HEADLESS with the default stdin are no", async () => {
		for (const k of ["CI", "EIGHT_UNATTENDED", "EIGHT_HEADLESS"]) {
			const logs: string[] = [];
			const res = await askOneYesDetailed("Run it? [y/N]", {
				label: "test",
				env: { [k]: "1" },
				log: (l) => logs.push(l),
				record: () => {},
			});
			expect(res).toEqual({ answer: false, reason: "unattended-env" });
		}
		expect(unattended({ CI: "1" }, { isTTY: true }, { isTTY: true })).toBe(true);
		expect(unattended({}, { isTTY: true }, { isTTY: true })).toBe(false);
		expect(unattended({ CI: "0" }, { isTTY: true }, { isTTY: true })).toBe(false);
	});

	test("CI=1 with an explicit stream and a typed y is still yes", async () => {
		for (const k of ["CI", "EIGHT_UNATTENDED", "EIGHT_HEADLESS"]) {
			const r = rig();
			const p = askOneYesDetailed("Run it? [y/N]", {
				...r.opts,
				env: { [k]: "1" },
				timeoutMs: 2000,
			});
			r.input.write("y\n");
			expect(await p).toEqual({ answer: true, reason: "yes" });
		}
	});

	test("an explicit yes or y inside the window is still yes", async () => {
		for (const word of ["y", "yes", "  YES "]) {
			const r = rig();
			const p = askOneYesDetailed("Allow? [y/N]", { ...r.opts, timeoutMs: 2000 });
			r.input.write(`${word}\n`);
			expect(await p).toEqual({ answer: true, reason: "yes" });
			expect(r.logs.length).toBe(0);
		}
	});

	test("no path defaults to yes: Enter, other words, closed input, errors", async () => {
		for (const line of ["\n", "n\n", "maybe\n", "yep\n", "ye\n"]) {
			const r = rig();
			const p = askOneYes("Allow? [y/N]", { ...r.opts, timeoutMs: 2000 });
			r.input.write(line);
			expect(await p).toBe(false);
		}
		const r = rig();
		const p = askOneYesDetailed("Allow? [y/N]", { ...r.opts, timeoutMs: 2000 });
		r.input.end();
		expect(await p).toEqual({ answer: false, reason: "closed-input" });
	});

	test("the timeout comes from EIGHT_ONE_YES_TIMEOUT_MS when set", async () => {
		const r = rig();
		const t0 = Date.now();
		const res = await askOneYesDetailed("Allow? [y/N]", {
			...r.opts,
			env: { EIGHT_ONE_YES_TIMEOUT_MS: "40" },
		});
		expect(res.reason).toBe("timeout");
		expect(Date.now() - t0).toBeLessThan(1500);
	});
});

describe("no one-yes prompt outside the helper (#4919)", () => {
	const root = join(import.meta.dir, "..");
	const sites = [
		"computer/desktop-approval.ts",
		"cron/scout.ts",
		"eight/judge-install.ts",
		"eight/source-update.ts",
		"eight/scripts/cua-run.ts",
		"eight/scripts/cua-setup.ts",
		"permissions/index.ts",
		"permissions/system-one-gate.ts",
	];
	for (const f of sites) {
		test(`${f} builds no readline prompt of its own`, () => {
			const src = readFileSync(join(root, f), "utf8");
			expect(src).not.toMatch(/createInterface|rl\.question|\[Y\/n\]: /);
			expect(src).not.toContain("Allow? [Y/n]");
		});
	}
});

describe("no prompt text reaches the log or the ledger (#4057, #4919)", () => {
	const MARKER = "hunter2-SECRET";
	const prompt = `Allow? will type exactly: "${MARKER}" [y/N]:`;
	const cases: [string, (r: ReturnType<typeof rig>) => Promise<unknown>][] = [
		["timeout", (r) => askOneYesDetailed(prompt, { ...r.opts, timeoutMs: 20 })],
		[
			"no-tty",
			(r) =>
				askOneYesDetailed(prompt, {
					...r.opts,
					input: Object.assign(new PassThrough(), { isTTY: false }),
				}),
		],
		[
			"unattended-env",
			(r) =>
				askOneYesDetailed(prompt, {
					label: "test",
					env: { CI: "1" },
					log: r.opts.log,
					record: r.opts.record,
				}),
		],
		[
			"closed-input",
			(r) => {
				const p = askOneYesDetailed(prompt, r.opts);
				r.input.end();
				return p;
			},
		],
		[
			"empty-answer",
			(r) => {
				const p = askOneYesDetailed(prompt, r.opts);
				r.input.write("\n");
				return p;
			},
		],
	];
	for (const [name, run] of cases) {
		test(`${name}: only label, reason and time are recorded`, async () => {
			const r = rig();
			await run(r);
			expect(r.logs.length).toBe(1);
			expect(r.ledger.length).toBe(1);
			expect(JSON.stringify(r.ledger)).not.toContain(MARKER);
			expect(r.logs.join("\n")).not.toContain(MARKER);
			expect(Object.keys(r.ledger[0] ?? {}).sort()).toEqual(["at", "event", "label", "reason"]);
			expect(r.ledger[0]?.reason).toBe(name);
		});
	}

	test("every call site passes a label", () => {
		const root = join(import.meta.dir, "..");
		const sites: [string, string][] = [
			["computer/desktop-approval.ts", "desktop-type"],
			["cron/scout.ts", "scout"],
			["eight/judge-install.ts", "judge-install"],
			["eight/source-update.ts", "source-update"],
			["eight/scripts/cua-run.ts", "cua-run"],
			["eight/scripts/cua-setup.ts", "cua-setup"],
			["permissions/index.ts", "permission"],
			["permissions/system-one-gate.ts", "system-one-escalation"],
		];
		for (const [f, label] of sites) {
			expect(readFileSync(join(root, f), "utf8")).toContain(`label: "${label}"`);
		}
	});
});

describe("refuseIfUnattended, for prompts the TUI shows itself (#4919)", () => {
	test("a person at a terminal is not refused and nothing is recorded", () => {
		const r = rig();
		expect(refuseIfUnattended("judge-install", r.opts)).toBe(false);
		expect(r.logs).toEqual([]);
		expect(r.ledger).toEqual([]);
	});
	for (const [name, env, tty] of [
		["CI", { CI: "1" }, true],
		["EIGHT_UNATTENDED", { EIGHT_UNATTENDED: "1" }, true],
		["EIGHT_HEADLESS", { EIGHT_HEADLESS: "1" }, true],
		["no terminal", {}, false],
	] as const) {
		test(`${name}: refused, one log line, label-only ledger row`, () => {
			const r = rig({ tty });
			expect(refuseIfUnattended("judge-install", { ...r.opts, env })).toBe(true);
			expect(r.logs.length).toBe(1);
			expect(r.ledger.length).toBe(1);
			expect(r.ledger[0]).toMatchObject({ event: "one-yes-resolved-no", label: "judge-install" });
		});
	}
});

// S0 of the terminal session ownership spec: a child 8gent in an owned terminal session has
// nobody present. The marker is the process's parents, not a variable a shell can strip.
describe("forcedUnattended and the owned-session ancestry", () => {
	const DIR = "/home/person/.8gent/term";
	type Rows = Record<number, [number, string]>;
	/** A process table as `ps -o ppid=,command= -p <pid>` shows it: pid -> [ppid, command]. */
	const table =
		(rows: Rows): ProcessLookup =>
		(pid) =>
			rows[pid] ? { ppid: rows[pid][0], command: rows[pid][1] } : undefined;
	const inPane = (rows: Rows, dirs = [DIR]) => inOwnedPane({ pid: 100, lookup: table(rows), dirs });

	test("each marker alone forces it, and neither does not", () => {
		expect(forcedUnattended({ EIGHT_UNATTENDED: "1" }, false)).toBe(true);
		expect(forcedUnattended({}, true)).toBe(true);
		expect(forcedUnattended({}, false)).toBe(false);
		expect(forcedUnattended({ EIGHT_UNATTENDED: "0" }, false)).toBe(false);
		expect(forcedUnattended({ EIGHT_UNATTENDED: "" }, false)).toBe(false);
	});

	test("a tmux server whose -S socket is under the app's term directory is found", () => {
		const sock = `tmux -S ${DIR}/123-abcd1234.sock new-session -d -s x sleep 99`;
		expect(inPane({ 100: [90, "bun run 8gent"], 90: [80, "/bin/sh -c cat"], 80: [1, sock] })).toBe(
			true,
		);
		const titled = `tmux: server (${DIR}/1-ab.sock)`;
		expect(inPane({ 100: [90, "bun"], 90: [80, "sh"], 80: [1, titled] })).toBe(true);
	});

	test("a person's own tmux is not found, nor a tmux on a socket elsewhere", () => {
		for (const cmd of [
			"tmux",
			"tmux new -s work",
			"tmux: server (/private/tmp/tmux-501/default)",
			"tmux -S /tmp/mine.sock new-session",
			`tmux new-session -d "cat ${DIR}/x"`,
			"tmux -S /elsewhere/.8gent/term/1-ab.sock new-session",
		]) {
			expect(inPane({ 100: [90, "bun"], 90: [80, "zsh"], 80: [1, cmd] })).toBe(false);
		}
	});

	test("a program other than tmux that names the socket is not a server", () => {
		expect(inPane({ 100: [90, "bun"], 90: [1, `vim -S ${DIR}/1-ab.sock`] })).toBe(false);
	});

	test("a server that hides its socket is found by the pid its spawner recorded", () => {
		const home = mkdtempSync(join(tmpdir(), "oy-"));
		const dir = join(home, ".8gent", "term");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "4242-deadbeef.pid"), "4242\n80\n");
		const hidden: Rows = { 100: [90, "bun"], 90: [80, "sh"], 80: [1, "tmux: server"] };
		try {
			expect(inPane(hidden, [dir])).toBe(true);
			// A recorded pid that belongs to something other than tmux proves nothing.
			expect(inPane({ ...hidden, 80: [1, "zsh"] }, [dir])).toBe(false);
			// No record: a hidden tmux is not claimed.
			rmSync(join(dir, "4242-deadbeef.pid"));
			expect(inPane(hidden, [dir])).toBe(false);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("the walk is capped, ends at pid 1, and an unreadable table answers false", () => {
		const loop: Rows = {};
		for (let i = 100; i < 200; i++) loop[i] = [i + 1, "sh"];
		let reads = 0;
		const counted: ProcessLookup = (pid) => {
			reads++;
			return table(loop)(pid);
		};
		expect(inOwnedPane({ pid: 100, lookup: counted, dirs: [DIR] })).toBe(false);
		expect(reads).toBeLessThanOrEqual(OWNED_PANE_MAX_HOPS + 1);
		expect(inPane({})).toBe(false);
	});

	test("unattended() is true with a terminal on both ends when EIGHT_UNATTENDED is set", () => {
		const tty = { isTTY: true };
		expect(unattended({}, tty, tty)).toBe(false);
		expect(unattended({ EIGHT_UNATTENDED: "1" }, tty, tty)).toBe(true);
	});
});
