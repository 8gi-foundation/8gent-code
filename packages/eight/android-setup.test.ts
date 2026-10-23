import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AndroidSetupDeps,
	androidAskLine,
	configPath,
	missingPackages,
	offerAndroidSetup,
	readSetup,
	writeSetup,
} from "./android-setup";

const ALL = ["mpv", "yt-dlp", "ffmpeg", "termux-speech-to-text"];

function rig(
	o: { have?: string[]; answer?: boolean | null; installCode?: number; mic?: boolean } = {},
) {
	const have = new Set(o.have ?? []);
	const log = {
		said: [] as string[],
		asked: [] as string[],
		runs: [] as string[][],
		writes: [] as unknown[],
	};
	let mic = o.mic ?? false;
	const deps: AndroidSetupDeps = {
		android: true,
		has: (b) => have.has(b),
		ask: async (line) => {
			log.asked.push(line);
			return o.answer === undefined ? true : o.answer;
		},
		run: async (cmd, args) => {
			log.runs.push([cmd, ...args]);
			if ((o.installCode ?? 0) === 0) for (const b of ALL) have.add(b);
			return o.installCode ?? 0;
		},
		say: (l) => log.said.push(l),
		progress: () => {},
		readState: () => ({ choice: null, mic }),
		writeState: (s) => {
			log.writes.push(s);
			if (s && "mic" in s && s.mic !== undefined) mic = s.mic;
			return true;
		},
	};
	return { deps, log };
}

describe("missingPackages", () => {
	test("maps tools to Termux packages: yt-dlp ships as python-yt-dlp, the mic is in termux-api", () => {
		expect(missingPackages(() => false)).toEqual(["mpv", "python-yt-dlp", "ffmpeg", "termux-api"]);
		expect(missingPackages((b) => b !== "mpv" && b !== "termux-speech-to-text")).toEqual([
			"mpv",
			"termux-api",
		]);
		expect(missingPackages(() => true)).toEqual([]);
	});
});

describe("offerAndroidSetup", () => {
	test("not Android: nothing asked, nothing run (macOS and Linux unchanged)", async () => {
		const { deps, log } = rig();
		expect(await offerAndroidSetup("auto", { ...deps, android: false })).toBe("not-android");
		expect(log.asked).toEqual([]);
		expect(log.runs).toEqual([]);
	});

	test("one question names every package, and discloses that audio may go to Google", async () => {
		const { deps, log } = rig({ answer: false });
		await offerAndroidSetup("auto", deps);
		expect(log.asked).toHaveLength(1);
		expect(log.asked[0]).toContain("mpv, python-yt-dlp, ffmpeg, termux-api");
		expect(log.asked[0]).toContain("Google");
		expect(log.asked[0]).not.toMatch(/agent/i);
		expect(log.asked[0].includes("\n")).toBe(false);
	});

	test("no yes, no install, and the no is recorded so it is not asked again", async () => {
		const { deps, log } = rig({ answer: false });
		expect(await offerAndroidSetup("auto", deps)).toBe("declined");
		expect(log.runs).toEqual([]);
		expect(log.writes).toContainEqual({ choice: "declined" });
		expect(
			await offerAndroidSetup("auto", {
				...deps,
				readState: () => ({ choice: "declined", mic: false }),
			}),
		).toBe("recorded");
		expect(log.asked).toHaveLength(1);
	});

	test("nobody to ask (not a terminal): nothing runs, nothing recorded", async () => {
		const { deps, log } = rig({ answer: null });
		expect(await offerAndroidSetup("auto", deps)).toBe("no-person");
		expect(log.runs).toEqual([]);
		expect(log.writes).toEqual([]);
	});

	test("yes: one pkg install, no sudo, consent recorded, F-Droid line said once", async () => {
		const { deps, log } = rig({ answer: true });
		expect(await offerAndroidSetup("auto", deps)).toBe("installed");
		expect(log.runs).toEqual([
			["pkg", "install", "-y", "mpv", "python-yt-dlp", "ffmpeg", "termux-api"],
		]);
		expect(log.runs.flat()).not.toContain("sudo");
		expect(log.writes).toContainEqual({ mic: true });
		expect(log.said.filter((l) => l.includes("F-Droid"))).toHaveLength(1);
		expect(log.said.join(" ")).toContain("/dj");
	});

	test("only what is missing is installed", async () => {
		const { deps, log } = rig({ have: ["mpv", "yt-dlp", "ffmpeg"], answer: true });
		await offerAndroidSetup("auto", deps);
		expect(log.runs).toEqual([["pkg", "install", "-y", "termux-api"]]);
	});

	test("install fails: says the exit code and the command to run by hand", async () => {
		const { deps, log } = rig({ answer: true, installCode: 100 });
		expect(await offerAndroidSetup("auto", deps)).toBe("failed");
		expect(log.said.at(-1)).toContain("pkg install -y mpv python-yt-dlp ffmpeg termux-api");
		expect(log.said.at(-1)).toContain("100");
	});

	test("tools present and mic consent given: ready, silent", async () => {
		const { deps, log } = rig({ have: ALL, mic: true });
		expect(await offerAndroidSetup("command", deps)).toBe("ready");
		expect(log.asked).toEqual([]);
		expect(log.said).toEqual([]);
	});

	test("tools present but no mic consent: asks only about voice input, installs nothing", async () => {
		const { deps, log } = rig({ have: ALL, answer: true });
		expect(await offerAndroidSetup("command", deps)).toBe("ready");
		expect(log.asked[0]).toContain("Google");
		expect(log.asked[0]).not.toContain("Installs");
		expect(log.runs).toEqual([]);
		expect(log.writes).toContainEqual({ mic: true });
	});

	test("command mode asks again even after an earlier no (pressing the mic is intent)", async () => {
		const { deps, log } = rig({ answer: true });
		const d = { ...deps, readState: () => ({ choice: "declined" as const, mic: false }) };
		expect(await offerAndroidSetup("command", d)).toBe("installed");
		expect(log.asked).toHaveLength(1);
	});

	test("after an update a bare Enter is No", () => {
		expect(androidAskLine(["mpv"], false)).toContain("[y/N]");
		expect(androidAskLine(["mpv"], true)).toContain("[Y/n]");
	});
});

describe("config on disk", () => {
	test("reads the recorded state and keeps unrelated keys", () => {
		const home = mkdtempSync(join(tmpdir(), "andsetup-"));
		const env = { HOME: home, EIGHT_HOME: home };
		const p = configPath(env);
		try {
			mkdirSync(join(home, ".8gent"), { recursive: true });
			writeFileSync(
				p,
				JSON.stringify({ other: 1, androidSetup: { choice: "declined", mic: true } }),
			);
			expect(readSetup(env)).toEqual({ choice: "declined", mic: true });
			expect(writeSetup({ choice: null }, env)).toBe(true);
			expect(readSetup(env)).toEqual({ choice: null, mic: true });
			expect(writeSetup({ choice: "failed" }, env)).toBe(true);
			expect(readSetup(env).choice).toBe("failed");
			expect(JSON.parse(readFileSync(p, "utf-8")).other).toBe(1);
			writeFileSync(p, "{not json");
			expect(writeSetup({ mic: true }, env)).toBe(false);
			expect(readFileSync(p, "utf-8")).toBe("{not json");
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
});
