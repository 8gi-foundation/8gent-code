/**
 * /dj offers to install missing tools with one yes (#4810).
 *
 * The installer goes through the same spawn seam as mpv, swapped here for a
 * stub, and tool lookup goes through setDjWhich, so no real pkg or brew runs
 * and nothing on this machine is installed.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import {
	DJ,
	installHint,
	installPlan,
	lastProgressLine,
	setDjSpawn,
	setDjTools,
	setDjWhich,
} from "../dj";

interface FakeInstaller extends EventEmitter {
	cmd: string;
	args: string[];
	stdout: EventEmitter;
	stderr: EventEmitter;
}

const spawned: FakeInstaller[] = [];
/** What the fake installer does when started. */
let behave: (c: FakeInstaller) => void = () => {};
/** Tools "on PATH" right now; an install-ok behaviour adds to it. */
let onPath: Set<string>;

beforeEach(() => {
	spawned.length = 0;
	onPath = new Set(["sox"]);
	setDjWhich((cmd) => (onPath.has(cmd) ? `/usr/bin/${cmd}` : null));
	setDjTools();
	setDjSpawn(((cmd: string, args: string[]) => {
		const c = new EventEmitter() as FakeInstaller;
		c.cmd = cmd;
		c.args = args;
		c.stdout = new EventEmitter();
		c.stderr = new EventEmitter();
		spawned.push(c);
		setTimeout(() => behave(c), 0);
		return c as unknown as ChildProcess;
	}) as never);
});

afterEach(() => {
	setDjSpawn();
	setDjWhich();
	setDjTools();
});

function harness(answer: boolean) {
	const said: string[] = [];
	const asked: string[] = [];
	const progress: string[] = [];
	return {
		said,
		asked,
		progress,
		io: {
			ask: async (q: string) => {
				asked.push(q);
				return answer;
			},
			say: (l: string) => said.push(l),
			progress: (l: string) => progress.push(l),
			plat: "android" as NodeJS.Platform,
		},
	};
}

describe("package names and plans", () => {
	test("Termux installs yt-dlp as python-yt-dlp, and the hint agrees", () => {
		expect(installHint("android")).toBe("pkg install mpv python-yt-dlp ffmpeg");
		const p = installPlan(["mpv", "yt-dlp", "ffmpeg"], "android");
		expect(p.display).toBe("pkg install -y mpv python-yt-dlp ffmpeg");
		expect(p.run).toEqual({
			cmd: "pkg",
			args: ["install", "-y", "mpv", "python-yt-dlp", "ffmpeg"],
		});
	});

	test("only the missing tools are installed", () => {
		expect(installPlan(["ffmpeg"], "android").display).toBe("pkg install -y ffmpeg");
	});

	test("macOS runs brew when brew exists, shows it when it does not", () => {
		expect(installPlan(["mpv"], "darwin", true).run).toEqual({
			cmd: "brew",
			args: ["install", "mpv"],
		});
		expect(installPlan(["mpv"], "darwin", false).run).toBeNull();
	});

	test("Linux and Windows show the command and never run it", () => {
		const l = installPlan(["mpv", "yt-dlp"], "linux");
		expect(l.display).toBe("sudo apt install mpv yt-dlp");
		expect(l.run).toBeNull();
		expect(installPlan(["mpv"], "win32").run).toBeNull();
	});

	test("progress keeps the last readable line, ansi and carriage returns stripped", () => {
		expect(lastProgressLine("Get:1 foo\r\n\x1b[32mUnpacking mpv\x1b[0m\n\n")).toBe("Unpacking mpv");
		expect(lastProgressLine("\n \n")).toBeNull();
	});
});

describe("ensureTools", () => {
	test("nothing missing: no question, no install", async () => {
		onPath = new Set(["mpv", "yt-dlp", "ffmpeg"]);
		const h = harness(true);
		expect(await new DJ().ensureTools(h.io)).toBe("none");
		expect(h.asked).toEqual([]);
		expect(spawned).toEqual([]);
	});

	test("offer: asks once, names the command, and runs nothing before the yes", async () => {
		let release!: (v: boolean) => void;
		const asked: string[] = [];
		const p = new DJ().ensureTools({
			ask: (q) => {
				asked.push(q);
				return new Promise<boolean>((r) => {
					release = r;
				});
			},
			say: () => {},
			plat: "android",
		});
		await new Promise((r) => setTimeout(r, 20));
		expect(asked).toHaveLength(1);
		expect(asked[0]).toContain("pkg install -y mpv python-yt-dlp ffmpeg");
		expect(spawned).toHaveLength(0);
		release(false);
		expect(await p).toBe("declined");
		expect(spawned).toHaveLength(0);
	});

	test("decline: shows the command as today and spawns nothing", async () => {
		const h = harness(false);
		expect(await new DJ().ensureTools(h.io)).toBe("declined");
		expect(spawned).toHaveLength(0);
		expect(h.said).toEqual(["Not installed. Run: pkg install -y mpv python-yt-dlp ffmpeg"]);
	});

	test("install ok: runs pkg, streams the last line, re-checks, reports ready", async () => {
		behave = (c) => {
			c.stdout.emit("data", Buffer.from("Unpacking mpv (0.41.0)\n"));
			c.stderr.emit("data", Buffer.from("Setting up ffmpeg\n"));
			for (const t of ["mpv", "yt-dlp", "ffmpeg"]) onPath.add(t);
			c.emit("close", 0);
		};
		const h = harness(true);
		const dj = new DJ();
		expect(await dj.ensureTools(h.io)).toBe("installed");
		expect(spawned).toHaveLength(1);
		expect(spawned[0].cmd).toBe("pkg");
		expect(spawned[0].args).toEqual(["install", "-y", "mpv", "python-yt-dlp", "ffmpeg"]);
		expect(h.progress).toEqual(["Unpacking mpv (0.41.0)", "Setting up ffmpeg"]);
		expect(dj.missingTools()).toEqual([]);
		expect(dj.doctor().mpv).toBe(true);
	});

	test("install fail: reports the exit code and the command, tools stay missing", async () => {
		behave = (c) => c.emit("close", 100);
		const h = harness(true);
		const dj = new DJ();
		expect(await dj.ensureTools(h.io)).toBe("failed");
		expect(h.said.at(-1)).toContain("install exited 100");
		expect(h.said.at(-1)).toContain("pkg install -y mpv python-yt-dlp ffmpeg");
		expect(dj.missingTools()).toEqual(["mpv", "yt-dlp", "ffmpeg"]);
	});

	test("install that cannot start (pkg not found) fails cleanly", async () => {
		behave = (c) => c.emit("error", new Error("ENOENT"));
		const h = harness(true);
		expect(await new DJ().ensureTools(h.io)).toBe("failed");
		expect(h.said.at(-1)).toContain("without starting");
	});

	test("exit 0 but a tool still missing is a failure that names it", async () => {
		behave = (c) => {
			onPath.add("mpv");
			c.emit("close", 0);
		};
		const h = harness(true);
		expect(await new DJ().ensureTools(h.io)).toBe("failed");
		expect(h.said.at(-1)).toContain("still missing: yt-dlp, ffmpeg");
	});

	test("Linux: no question, no spawn, shows the apt command", async () => {
		const h = harness(true);
		expect(await new DJ().ensureTools({ ...h.io, plat: "linux" })).toBe("manual");
		expect(h.asked).toEqual([]);
		expect(spawned).toHaveLength(0);
		expect(h.said[0]).toContain("sudo apt install mpv yt-dlp ffmpeg");
	});

	test("macOS without brew: shows the command, never spawns", async () => {
		const h = harness(true);
		expect(await new DJ().ensureTools({ ...h.io, plat: "darwin" })).toBe("manual");
		expect(spawned).toHaveLength(0);
	});

	test("macOS with brew asks, then runs brew install of the missing tools only", async () => {
		onPath = new Set(["sox", "brew", "mpv"]);
		behave = (c) => {
			onPath.add("yt-dlp");
			onPath.add("ffmpeg");
			c.emit("close", 0);
		};
		const h = harness(true);
		expect(await new DJ().ensureTools({ ...h.io, plat: "darwin" })).toBe("installed");
		expect(spawned[0].cmd).toBe("brew");
		expect(spawned[0].args).toEqual(["install", "yt-dlp", "ffmpeg"]);
	});
});
