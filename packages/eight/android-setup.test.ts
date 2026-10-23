import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AndroidSetupDeps,
	MIC_DISCLOSURE,
	MIC_READY_LINE,
	type SetupPatch,
	type SetupState,
	answerFromLine,
	configPath,
	micAskLine,
	missingMusic,
	musicAskLine,
	offerAndroidSetup,
	readSetup,
	writeSetup,
} from "./android-setup";

const ALL = ["mpv", "yt-dlp", "ffmpeg", "termux-speech-to-text"];

/** Answers are consumed in order, one per question; a missing answer is a typed yes. */
function rig(
	o: {
		have?: string[];
		answers?: (boolean | null)[];
		installCode?: number;
		state?: Partial<SetupState>;
	} = {},
) {
	const have = new Set(o.have ?? []);
	const answers = [...(o.answers ?? [])];
	const log = {
		said: [] as string[],
		asked: [] as { line: string; defaultYes: boolean }[],
		runs: [] as string[][],
		writes: [] as SetupPatch[],
	};
	const st: SetupState = { choice: null, mic: false, micDeclined: false, ...o.state };
	const deps: AndroidSetupDeps = {
		android: true,
		has: (b) => have.has(b),
		ask: async (line, defaultYes) => {
			log.asked.push({ line, defaultYes });
			return answers.length ? (answers.shift() as boolean | null) : true;
		},
		run: async (cmd, args) => {
			log.runs.push([cmd, ...args]);
			if ((o.installCode ?? 0) === 0) for (const b of ALL) have.add(b);
			return o.installCode ?? 0;
		},
		say: (l) => log.said.push(l),
		progress: () => {},
		readState: () => ({ ...st }),
		writeState: (p) => {
			log.writes.push(p);
			Object.assign(st, p);
			return true;
		},
	};
	return { deps, log, st };
}

describe("lines", () => {
	test("the disclosure is the agreed wording and names the off switch", () => {
		expect(MIC_DISCLOSURE).toBe(
			"Voice input uses your phone's speech service (often Google), which may send your audio off the phone. /voice mic off turns it off.",
		);
		expect(micAskLine(true)).toContain(MIC_DISCLOSURE);
		expect(MIC_READY_LINE).toContain("/voice mic off");
	});

	test("the mic question is always [y/N]; music follows the launch default; no a-word", () => {
		expect(micAskLine(false)).toEndWith("[y/N]");
		expect(micAskLine(true)).toContain("installs termux-api");
		expect(musicAskLine(["mpv"], true)).toEndWith("[Y/n]");
		expect(musicAskLine(["mpv"], false)).toEndWith("[y/N]");
		expect(musicAskLine(["mpv"]) + micAskLine(true)).not.toMatch(/agent/i);
	});

	test("the music question never mentions the mic or Google", () => {
		expect(musicAskLine(["mpv", "ffmpeg"])).not.toMatch(/google|voice|termux-api/i);
	});

	test("yt-dlp ships as python-yt-dlp", () => {
		expect(missingMusic(() => false)).toEqual(["mpv", "python-yt-dlp", "ffmpeg"]);
		expect(missingMusic((b) => b === "mpv")).toEqual(["python-yt-dlp", "ffmpeg"]);
		expect(missingMusic(() => true)).toEqual([]);
	});
});

describe("answerFromLine", () => {
	test("an empty line takes the question's default; only y or yes is yes otherwise", () => {
		expect(answerFromLine("", true)).toBe(true);
		expect(answerFromLine("", false)).toBe(false);
		expect(answerFromLine("  ", false)).toBe(false);
		expect(answerFromLine("y", false)).toBe(true);
		expect(answerFromLine("YES", false)).toBe(true);
		expect(answerFromLine("yeah", true)).toBe(false);
		expect(answerFromLine("n", true)).toBe(false);
	});
});

describe("launch (auto)", () => {
	test("not Android: nothing asked, nothing run", async () => {
		const { deps, log } = rig();
		expect(await offerAndroidSetup("auto", { ...deps, android: false })).toBe("not-android");
		expect(log.asked).toEqual([]);
		expect(log.runs).toEqual([]);
	});

	test("two separate questions, music first with the launch default, mic [y/N]", async () => {
		const { deps, log } = rig({ answers: [false, false] });
		await offerAndroidSetup("auto", deps);
		expect(log.asked).toHaveLength(2);
		expect(log.asked[0].line).toContain("mpv, python-yt-dlp, ffmpeg");
		expect(log.asked[0].defaultYes).toBe(true);
		expect(log.asked[1].defaultYes).toBe(false);
		expect(log.asked[1].line).toContain("Google");
	});

	test("yes to music, no to the mic: only music packages installed, mic never consented", async () => {
		const { deps, log, st } = rig({ answers: [true, false] });
		await offerAndroidSetup("auto", deps);
		expect(log.runs).toEqual([["pkg", "install", "-y", "mpv", "python-yt-dlp", "ffmpeg"]]);
		expect(st.mic).toBe(false);
		expect(st.micDeclined).toBe(true);
		expect(log.writes.some((w) => w.mic === true)).toBe(false);
	});

	test("no to music, yes to the mic: only termux-api installed", async () => {
		const { deps, log, st } = rig({ answers: [false, true] });
		await offerAndroidSetup("auto", deps);
		expect(log.runs).toEqual([["pkg", "install", "-y", "termux-api"]]);
		expect(st.choice).toBe("declined");
		expect(st.mic).toBe(true);
	});

	test("yes to both: no sudo, ready line names /voice mic off, F-Droid app named once", async () => {
		const { deps, log } = rig({ answers: [true, true] });
		expect(await offerAndroidSetup("auto", deps)).toBe("installed");
		expect(log.runs.flat()).not.toContain("sudo");
		expect(log.said.filter((l) => l === MIC_READY_LINE)).toHaveLength(1);
		expect(log.said.filter((l) => l.includes("F-Droid"))).toHaveLength(1);
	});

	test("nothing runs before a yes", async () => {
		const { deps, log } = rig({ answers: [false, false] });
		await offerAndroidSetup("auto", deps);
		expect(log.runs).toEqual([]);
	});

	test("both asked once ever: recorded answers end the asking", async () => {
		const { deps, log } = rig({ state: { choice: "declined", micDeclined: true } });
		expect(await offerAndroidSetup("auto", deps)).toBe("recorded");
		expect(log.asked).toEqual([]);
	});

	test("nobody to ask: nothing runs, nothing recorded", async () => {
		const { deps, log } = rig({ answers: [null] });
		expect(await offerAndroidSetup("auto", deps)).toBe("no-person");
		expect(log.runs).toEqual([]);
		expect(log.writes).toEqual([]);
	});

	test("a failed music install is reported with the command and recorded; the mic is still asked", async () => {
		const { deps, log, st } = rig({ answers: [true, false], installCode: 100 });
		expect(await offerAndroidSetup("auto", deps)).toBe("failed");
		expect(log.said.some((l) => l.includes("pkg install -y mpv python-yt-dlp ffmpeg"))).toBe(true);
		expect(st.choice).toBe("failed");
		expect(log.asked).toHaveLength(2);
	});
});

describe("the mic key (command)", () => {
	test("consent on and termux-api present: ready, silent", async () => {
		const { deps, log } = rig({ have: ALL, state: { mic: true } });
		expect(await offerAndroidSetup("command", deps)).toBe("ready");
		expect(log.asked).toEqual([]);
		expect(log.said).toEqual([]);
	});

	test("never asks about music", async () => {
		const { deps, log } = rig({ answers: [true] });
		await offerAndroidSetup("command", deps);
		expect(log.asked).toHaveLength(1);
		expect(log.asked[0].line).toContain("voice input");
		expect(log.asked[0].defaultYes).toBe(false);
	});

	test("after /voice mic off the next press asks again, and a no means nothing listens", async () => {
		const { deps, log, st } = rig({ have: ALL, state: { mic: true }, answers: [false] });
		expect(await offerAndroidSetup("command", deps)).toBe("ready");
		expect(log.asked).toEqual([]);
		// What /voice mic off does: writeSetup({ mic: false }).
		deps.writeState?.({ mic: false });
		const r = await offerAndroidSetup("command", deps);
		expect(log.asked).toHaveLength(1);
		expect(r).not.toBe("ready");
		expect(r).not.toBe("installed");
		expect(st.mic).toBe(false);
		expect(log.runs).toEqual([]);
	});

	test("asks again even after a launch-time no (pressing the mic is intent)", async () => {
		const { deps, log } = rig({ have: ALL, state: { micDeclined: true }, answers: [true] });
		expect(await offerAndroidSetup("command", deps)).toBe("ready");
		expect(log.asked).toHaveLength(1);
		expect(log.writes).toContainEqual({ mic: true });
	});

	test("consent without termux-api asks again and installs only termux-api", async () => {
		const { deps, log } = rig({
			have: ["mpv", "yt-dlp", "ffmpeg"],
			state: { mic: true },
			answers: [true],
		});
		expect(await offerAndroidSetup("command", deps)).toBe("installed");
		expect(log.runs).toEqual([["pkg", "install", "-y", "termux-api"]]);
	});
});

describe("config on disk", () => {
	test("round trips, keeps unrelated keys, never overwrites a file it cannot parse", () => {
		const home = mkdtempSync(join(tmpdir(), "andsetup-"));
		const env = { HOME: home, EIGHT_HOME: home };
		const p = configPath(env);
		try {
			mkdirSync(join(home, ".8gent"), { recursive: true });
			writeFileSync(
				p,
				JSON.stringify({ other: 1, androidSetup: { choice: "declined", mic: true } }),
			);
			expect(readSetup(env)).toEqual({ choice: "declined", mic: true, micDeclined: false });
			expect(writeSetup({ choice: null }, env)).toBe(true);
			expect(writeSetup({ mic: false }, env)).toBe(true);
			expect(readSetup(env)).toEqual({ choice: null, mic: false, micDeclined: false });
			expect(writeSetup({ micDeclined: true }, env)).toBe(true);
			expect(readSetup(env).micDeclined).toBe(true);
			expect(JSON.parse(readFileSync(p, "utf-8")).other).toBe(1);
			writeFileSync(p, "{not json");
			expect(writeSetup({ mic: true }, env)).toBe(false);
			expect(readFileSync(p, "utf-8")).toBe("{not json");
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
});
