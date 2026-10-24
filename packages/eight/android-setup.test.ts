import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PHONE_MODELS, type PhoneModel } from "../voice/termux-local-stt";
import {
	type AndroidSetupDeps,
	CLOUD_DISCLOSURE,
	CLOUD_READY_LINE,
	LOCAL_DISCLOSURE,
	MIC_READY_LINE,
	type SetupPatch,
	type SetupState,
	answerFromLine,
	cloudAskLine,
	configPath,
	micAskLine,
	missingMusic,
	modelAskLine,
	musicAskLine,
	offerAndroidSetup,
	offerCloudVoice,
	readSetup,
	unattended,
	voiceEngine,
	writeSetup,
} from "./android-setup";

/** Every Termux command the offers check for. */
const ALL = [
	"mpv",
	"yt-dlp",
	"ffmpeg",
	"termux-microphone-record",
	"termux-speech-to-text",
	"clang",
	"cmake",
	"make",
];
/** A phone with music and the mic tools but no whisper.cpp and no model. */
const NO_WHISPER = ["mpv", "yt-dlp", "ffmpeg", "termux-microphone-record"];
const NOTHING = { pkgs: [], whisper: false, model: false };
const EVERYTHING = { pkgs: ["termux-api", "ffmpeg"], whisper: true, model: true };

/** Answers are consumed in order, one per question; a missing answer is a typed yes. */
function rig(
	o: {
		have?: string[];
		answers?: (boolean | null)[];
		installCode?: number;
		state?: Partial<SetupState>;
		whisper?: boolean;
		model?: boolean;
		buildFails?: boolean;
		modelFails?: boolean;
	} = {},
) {
	const have = new Set(o.have ?? []);
	const answers = [...(o.answers ?? [])];
	let whisper = o.whisper ?? false;
	let model = o.model ?? false;
	const log = {
		said: [] as string[],
		asked: [] as { line: string; defaultYes: boolean }[],
		runs: [] as string[][],
		writes: [] as SetupPatch[],
		builds: 0,
		models: [] as PhoneModel[],
	};
	const st: SetupState = {
		choice: null,
		mic: false,
		micDeclined: false,
		cloud: false,
		...o.state,
	};
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
		findWhisper: () => (whisper ? "/fake/whisper-cli" : null),
		findModel: () => (model ? "/fake/ggml-tiny.en.bin" : null),
		buildWhisper: async () => {
			log.builds++;
			if (o.buildFails)
				return { error: "Building whisper.cpp v1.9.5 did not finish (cmake exit 1)." };
			whisper = true;
			return { path: "/fake/whisper-cli" };
		},
		installModel: async (m) => {
			log.models.push(m);
			if (o.modelFails)
				return { error: "ggml-tiny.en.bin failed its checksum, so it was deleted." };
			model = true;
			return { path: `/fake/${PHONE_MODELS[m].filename}` };
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

/** Every command the rig ran, flattened, for "did anything reach the network or the cloud" checks. */
const ran = (log: { runs: string[][] }) => log.runs.map((r) => r.join(" "));

describe("lines", () => {
	test("the mic question names the local default, whisper.cpp, and the cloud option as opt-in", () => {
		const line = micAskLine(EVERYTHING);
		expect(line).toStartWith("Turn on voice input? ");
		expect(line).toContain(LOCAL_DISCLOSURE);
		expect(LOCAL_DISCLOSURE).toContain("on this phone with whisper.cpp");
		expect(LOCAL_DISCLOSURE).toContain("Your audio never leaves the phone.");
		expect(line).toContain("/voice mic cloud");
		expect(line).toContain("sends audio off the phone");
		expect(line).toEndWith("[y/N]");
	});

	test("the mic question names what it installs: clang, cmake and make, plus the whisper.cpp build", () => {
		const line = micAskLine({ pkgs: [], whisper: true, model: false });
		expect(line).toContain("the build tools clang, cmake and make");
		expect(line).toContain("the whisper.cpp build");
		// Nothing to build, nothing named.
		expect(micAskLine({ pkgs: [], whisper: false, model: true })).not.toContain("clang");
	});

	test("the mic question says termux-api is for the microphone and the audio still stays local", () => {
		expect(micAskLine(EVERYTHING)).toContain(
			"Sets up termux-api (it only opens the microphone; the audio stays here), ffmpeg, the build tools clang, cmake and make, the whisper.cpp build (on the phone, a few minutes) and a speech model. ",
		);
		expect(micAskLine(NOTHING)).not.toContain("Sets up");
		expect(micAskLine({ pkgs: [], whisper: false, model: true })).toContain(
			"Sets up a speech model. ",
		);
	});

	test("the model question offers tiny by default and base by a typed yes, with real sizes", () => {
		expect(modelAskLine()).toBe(
			"Speech model: tiny (78 MB, faster) suits most phones. Use base (148 MB, more accurate) instead? [y/N]",
		);
	});

	test("the cloud question says plainly that audio leaves the phone", () => {
		expect(CLOUD_DISCLOSURE).toBe(
			"Your audio leaves this phone: Android sends it to its speech service, often Google.",
		);
		expect(cloudAskLine(true)).toContain(CLOUD_DISCLOSURE);
		expect(cloudAskLine(true)).toContain("Installs termux-api.");
		expect(cloudAskLine(false)).not.toContain("Installs");
		expect(cloudAskLine(false)).toEndWith("[y/N]");
		expect(CLOUD_READY_LINE).toContain("audio leaves the phone");
	});

	test("ready line says the audio stays on the phone and names the off switch", () => {
		expect(MIC_READY_LINE).toContain("stays on this phone");
		expect(MIC_READY_LINE).toContain("/voice mic off");
		expect(MIC_READY_LINE).toContain("Ctrl+R again stops it");
	});

	test("no em dashes and no a-word in any prompt", () => {
		const all = [
			musicAskLine(["mpv"]),
			micAskLine(EVERYTHING),
			modelAskLine(),
			cloudAskLine(true),
			MIC_READY_LINE,
			CLOUD_READY_LINE,
		].join(" ");
		expect(all).not.toMatch(/agent/i);
		expect(all).not.toContain("\u2014");
	});

	test("the music question never mentions the mic or Google", () => {
		expect(musicAskLine(["mpv", "ffmpeg"])).not.toMatch(/google|voice|termux-api/i);
		expect(musicAskLine(["mpv"], true)).toEndWith("[Y/n]");
		expect(musicAskLine(["mpv"], false)).toEndWith("[y/N]");
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
		expect(await offerCloudVoice({ ...deps, android: false })).toBe("not-android");
		expect(log.asked).toEqual([]);
		expect(log.runs).toEqual([]);
	});

	test("two separate questions, both [y/N]: a bare Enter installs nothing, mic names the local path", async () => {
		const { deps, log } = rig({ answers: [false, false] });
		await offerAndroidSetup("auto", deps);
		expect(log.asked).toHaveLength(2);
		expect(log.asked[0].line).toContain("mpv, python-yt-dlp, ffmpeg");
		expect(log.asked[0].defaultYes).toBe(false);
		expect(log.asked[0].line).toContain("[y/N]");
		expect(log.asked[1].defaultYes).toBe(false);
		expect(log.asked[1].line).toContain("whisper.cpp");
	});

	test("unattended (CI, EIGHT_UNATTENDED, no terminal): the real prompt resolves to no person at once, nothing installs or is recorded", async () => {
		for (const env of [{ CI: "1" }, { EIGHT_UNATTENDED: "1" }, {}]) {
			// The default ask, not the rig's: bun test has no TTY on stdin either.
			const { deps, log } = rig({});
			const t0 = performance.now();
			const out = await offerAndroidSetup("auto", {
				...deps,
				ask: undefined,
				env: { TERMUX_VERSION: "0.118", ...env },
			});
			expect(out).toBe("no-person");
			expect(performance.now() - t0).toBeLessThan(500);
			expect(log.runs).toEqual([]);
			expect(log.writes).toEqual([]);
		}
	});

	test("unattended is true for CI or EIGHT_UNATTENDED, and not for 0 or false", () => {
		expect(unattended({ CI: "true" })).toBe(true);
		expect(unattended({ EIGHT_UNATTENDED: "1" })).toBe(true);
		// With a terminal these would be false; the flags alone must not turn it on.
		const tty = process.stdin.isTTY && process.stdout.isTTY;
		if (tty) expect(unattended({ CI: "0", EIGHT_UNATTENDED: "false" })).toBe(false);
	});

	test("yes to music, no to the mic: only music packages installed, mic never consented", async () => {
		const { deps, log, st } = rig({ answers: [true, false] });
		await offerAndroidSetup("auto", deps);
		expect(log.runs).toEqual([["pkg", "install", "-y", "mpv", "python-yt-dlp", "ffmpeg"]]);
		expect(st.mic).toBe(false);
		expect(st.micDeclined).toBe(true);
		expect(log.builds).toBe(0);
		expect(log.models).toEqual([]);
	});

	test("yes to the mic on a bare phone: one install step, whisper.cpp built, tiny chosen by default", async () => {
		// music no, mic yes, model question: bare Enter (false)
		const { deps, log, st } = rig({ answers: [false, true, false] });
		expect(await offerAndroidSetup("auto", deps)).toBe("installed");
		expect(log.asked.map((a) => a.line)).toContain(modelAskLine());
		expect(log.asked.find((a) => a.line === modelAskLine())?.defaultYes).toBe(false);
		expect(log.runs).toEqual([
			["pkg", "install", "-y", "termux-api", "ffmpeg", "clang", "cmake", "make"],
		]);
		expect(log.builds).toBe(1);
		expect(log.models).toEqual(["tiny"]);
		expect(st.mic).toBe(true);
		expect(st.cloud).toBe(false);
		expect(log.said).toContain(MIC_READY_LINE);
	});

	test("a typed yes to the model question picks base", async () => {
		const { deps, log } = rig({ have: NO_WHISPER, answers: [true, true] });
		expect(await offerAndroidSetup("command", deps)).toBe("installed");
		expect(log.models).toEqual(["base"]);
	});

	test("no model question when a model is already installed; no build when whisper.cpp is present", async () => {
		const { deps, log } = rig({ have: NO_WHISPER, whisper: true, model: true, answers: [true] });
		expect(await offerAndroidSetup("command", deps)).toBe("ready");
		expect(log.asked).toHaveLength(1);
		expect(log.builds).toBe(0);
		expect(log.models).toEqual([]);
		expect(log.runs).toEqual([]);
	});

	test("yes to the mic never installs or uses the cloud tool", async () => {
		const { deps, log, st } = rig({ answers: [true, true, false] });
		await offerAndroidSetup("auto", deps);
		expect(ran(log).join(" ")).not.toContain("termux-speech-to-text");
		expect(st.cloud).toBe(false);
		expect(log.writes.some((w) => w.cloud === true)).toBe(false);
	});

	test("nothing runs before a yes", async () => {
		const { deps, log } = rig({ answers: [false, false] });
		await offerAndroidSetup("auto", deps);
		expect(log.runs).toEqual([]);
		expect(log.builds).toBe(0);
		expect(log.models).toEqual([]);
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

	test("a failed whisper.cpp build is said and stops before the model download", async () => {
		const { deps, log } = rig({ have: NO_WHISPER, answers: [true, false], buildFails: true });
		expect(await offerAndroidSetup("command", deps)).toBe("failed");
		expect(log.said.some((l) => l.startsWith("Building whisper.cpp"))).toBe(true);
		expect(log.models).toEqual([]);
		expect(log.said).not.toContain(MIC_READY_LINE);
	});

	test("a model that fails its checksum is reported and voice input is not called ready", async () => {
		const { deps, log } = rig({
			have: NO_WHISPER,
			whisper: true,
			answers: [true, false],
			modelFails: true,
		});
		expect(await offerAndroidSetup("command", deps)).toBe("failed");
		expect(log.said.some((l) => l.includes("checksum"))).toBe(true);
		expect(log.said).not.toContain(MIC_READY_LINE);
	});
});

describe("the mic key (command)", () => {
	test("consent on and everything local present: ready, silent, local engine", async () => {
		const { deps, log, st } = rig({ have: ALL, whisper: true, model: true, state: { mic: true } });
		expect(await offerAndroidSetup("command", deps)).toBe("ready");
		expect(log.asked).toEqual([]);
		expect(log.said).toEqual([]);
		expect(voiceEngine(st)).toBe("local");
	});

	test("an old cloud consent (mic on, no whisper) is moved to the local path, not to the cloud", async () => {
		// Before #4905, mic:true meant the phone's speech service. It now means voice input, on the phone.
		const { deps, log, st } = rig({ have: ALL, state: { mic: true }, answers: [true, false] });
		expect(await offerAndroidSetup("command", deps)).toBe("installed");
		expect(log.asked[0].line).toContain("whisper.cpp");
		expect(voiceEngine(st)).toBe("local");
	});

	test("never asks about music", async () => {
		const { deps, log } = rig({ have: NO_WHISPER, whisper: true, model: true, answers: [true] });
		await offerAndroidSetup("command", deps);
		expect(log.asked).toHaveLength(1);
		expect(log.asked[0].line).toContain("voice input");
		expect(log.asked[0].defaultYes).toBe(false);
	});

	test("after /voice mic off the next press asks again, and a no means nothing listens", async () => {
		const { deps, log, st } = rig({
			have: ALL,
			whisper: true,
			model: true,
			state: { mic: true },
			answers: [false],
		});
		expect(await offerAndroidSetup("command", deps)).toBe("ready");
		expect(log.asked).toEqual([]);
		deps.writeState?.({ mic: false, cloud: false });
		const r = await offerAndroidSetup("command", deps);
		expect(log.asked).toHaveLength(1);
		expect(r).not.toBe("ready");
		expect(r).not.toBe("installed");
		expect(st.mic).toBe(false);
		expect(log.runs).toEqual([]);
	});

	test("asks again even after a launch-time no (pressing the mic is intent)", async () => {
		const { deps, log } = rig({
			have: ALL,
			whisper: true,
			model: true,
			state: { micDeclined: true },
			answers: [true],
		});
		expect(await offerAndroidSetup("command", deps)).toBe("ready");
		expect(log.asked).toHaveLength(1);
		expect(log.writes).toContainEqual({ mic: true });
	});
});

describe("cloud is opt-in only (/voice mic cloud)", () => {
	test("the cloud engine is never chosen without a typed yes to the cloud question", async () => {
		const { deps, st } = rig({ answers: [true, true, false] });
		await offerAndroidSetup("auto", deps);
		expect(voiceEngine(st)).toBe("local");
	});

	test("a no (or bare Enter) to the cloud question leaves voice local", async () => {
		const { deps, log, st } = rig({ have: ALL, answers: [false] });
		expect(await offerCloudVoice(deps)).toBe("declined");
		expect(log.asked).toEqual([{ line: cloudAskLine(false), defaultYes: false }]);
		expect(st.cloud).toBe(false);
		expect(voiceEngine(st)).toBe("local");
		expect(log.runs).toEqual([]);
	});

	test("a yes turns cloud on, installs only termux-api if missing, and says the audio leaves", async () => {
		const { deps, log, st } = rig({ answers: [true] });
		expect(await offerCloudVoice(deps)).toBe("installed");
		expect(log.runs).toEqual([["pkg", "install", "-y", "termux-api"]]);
		expect(st.cloud).toBe(true);
		expect(st.mic).toBe(true);
		expect(voiceEngine(st)).toBe("cloud");
		expect(log.said).toContain(CLOUD_READY_LINE);
		expect(log.builds).toBe(0);
	});

	test("with cloud chosen and its tool present, the mic key is silent and ready", async () => {
		const { deps, log } = rig({ have: ALL, state: { mic: true, cloud: true } });
		expect(await offerAndroidSetup("command", deps)).toBe("ready");
		expect(log.asked).toEqual([]);
	});

	test("with cloud chosen but termux-api gone, the key asks the cloud question again, never silently", async () => {
		const { deps, log } = rig({ state: { mic: true, cloud: true }, answers: [false] });
		expect(await offerAndroidSetup("command", deps)).toBe("declined");
		expect(log.asked[0].line).toContain(CLOUD_DISCLOSURE);
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
			expect(readSetup(env)).toEqual({
				choice: "declined",
				mic: true,
				micDeclined: false,
				cloud: false,
			});
			expect(writeSetup({ choice: null }, env)).toBe(true);
			expect(writeSetup({ mic: false }, env)).toBe(true);
			expect(readSetup(env)).toEqual({
				choice: null,
				mic: false,
				micDeclined: false,
				cloud: false,
			});
			expect(writeSetup({ cloud: true }, env)).toBe(true);
			expect(readSetup(env).cloud).toBe(true);
			expect(writeSetup({ cloud: false }, env)).toBe(true);
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
