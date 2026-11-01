/**
 * Audio is deleted on every path (#4910 review, FIX FIRST): a recording that is
 * still running when 8gent exits must stop the mic and remove the audio, leftovers
 * from a killed run are swept, and the whisper-cli install is atomic.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	VOICE_DIR_GRACE_MS,
	buildWhisper,
	installExecutable,
	managedWhisperBin,
	startRecording,
	sweepVoiceDirs,
} from "./termux-local-stt.js";

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "voice-cleanup-"));
});
afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

const MODULE = join(import.meta.dir, "termux-local-stt.ts");

/**
 * The reviewer's repro: startRecording with a stub `run` that writes the file,
 * then the process ends. `how` is how it ends. Runs in a real child process so
 * 'exit' and signals are the real ones.
 */
function recordingScript(how: "exit" | "wait"): string {
	return `
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startRecording } from ${JSON.stringify(MODULE)};
const dir = process.env.AUDIO_DIR;
const marker = process.env.MARKER;
mkdirSync(dir, { recursive: true });
const rec = await startRecording({
	whisperBin: "/fake", modelPath: "/fake",
	sweep: () => {},
	makeDir: () => dir,
	quitSync: () => writeFileSync(marker, "quit -q"),
	run: async (_cmd, args) => { if (args[0] === "-f") writeFileSync(args[1], "aac-bytes"); return 0; },
});
if ("error" in rec) { console.error(rec.error); process.exit(3); }
${how === "exit" ? "process.exit(0);" : 'console.log("recording"); setInterval(() => {}, 1000);'}
`;
}

function runScript(how: "exit" | "wait") {
	const script = join(root, `repro-${how}.ts`);
	writeFileSync(script, recordingScript(how));
	const audio = join(root, `audio-${how}`);
	const marker = join(root, `marker-${how}`);
	return { script, audio, marker, env: { ...process.env, AUDIO_DIR: audio, MARKER: marker } };
}

describe("exit while recording", () => {
	test("process.exit(0) mid-recording stops the mic and removes voice.m4a", () => {
		const r = runScript("exit");
		const res = spawnSync("bun", ["run", r.script], { env: r.env, encoding: "utf-8" });
		expect(res.status).toBe(0);
		expect(existsSync(join(r.audio, "voice.m4a"))).toBe(false);
		expect(existsSync(r.audio)).toBe(false);
		expect(readFileSync(r.marker, "utf-8")).toBe("quit -q");
	});

	test("SIGTERM mid-recording stops the mic, removes the audio, and still ends the process by the signal", async () => {
		const r = runScript("wait");
		const child = Bun.spawn(["bun", "run", r.script], {
			env: r.env,
			stdout: "pipe",
			stderr: "ignore",
		});
		const reader = child.stdout.getReader();
		let seen = "";
		while (!seen.includes("recording")) {
			const { value, done } = await reader.read();
			if (done) break;
			seen += new TextDecoder().decode(value);
		}
		expect(existsSync(join(r.audio, "voice.m4a"))).toBe(true);
		child.kill("SIGTERM");
		await child.exited;
		expect(child.signalCode).toBe("SIGTERM");
		expect(existsSync(r.audio)).toBe(false);
		expect(readFileSync(r.marker, "utf-8")).toBe("quit -q");
	}, 20000);

	test("SIGINT does the same", async () => {
		const r = runScript("wait");
		const child = Bun.spawn(["bun", "run", r.script], {
			env: r.env,
			stdout: "pipe",
			stderr: "ignore",
		});
		const reader = child.stdout.getReader();
		let seen = "";
		while (!seen.includes("recording")) {
			const { value, done } = await reader.read();
			if (done) break;
			seen += new TextDecoder().decode(value);
		}
		child.kill("SIGINT");
		await child.exited;
		expect(existsSync(r.audio)).toBe(false);
		expect(existsSync(r.marker)).toBe(true);
	}, 20000);

	test("handlers are removed when the recording ends, so nothing piles up", async () => {
		const before = ["exit", "SIGINT", "SIGTERM"].map((e) => process.listenerCount(e));
		const rec = await startRecording({
			whisperBin: "/fake",
			modelPath: "/fake",
			sweep: () => {},
			quitSync: () => {},
			makeDir: () => mkdtempSync(join(root, "v-")),
			sleep: async () => {},
			run: async (_c, args) => {
				if (args[0] === "-f") writeFileSync(args[1], "x");
				return 0;
			},
			capture: async () => ({ code: 1, out: "" }),
		});
		if ("error" in rec) throw new Error(rec.error);
		expect(["exit", "SIGINT", "SIGTERM"].map((e) => process.listenerCount(e))).toEqual(
			before.map((n) => n + 1),
		);
		rec.stop();
		await rec.done;
		expect(["exit", "SIGINT", "SIGTERM"].map((e) => process.listenerCount(e))).toEqual(before);
	});

	test("abort (unmount) deletes the audio and transcribes nothing", async () => {
		let dir = "";
		let quit = 0;
		const captured: string[] = [];
		const rec = await startRecording({
			whisperBin: "/fake",
			modelPath: "/fake",
			sweep: () => {},
			quitSync: () => {
				quit++;
			},
			makeDir: () => {
				dir = mkdtempSync(join(root, "v-"));
				return dir;
			},
			sleep: async () => {},
			run: async (_c, args) => {
				if (args[0] === "-f") writeFileSync(args[1], "x");
				return 0;
			},
			capture: async (cmd) => {
				captured.push(cmd);
				return { code: 0, out: "" };
			},
		});
		if ("error" in rec) throw new Error(rec.error);
		rec.abort();
		expect(existsSync(dir)).toBe(false);
		expect(await rec.done).toEqual({ error: "Recording cancelled." });
		expect(quit).toBe(1);
		expect(captured).toEqual([]);
	});
});

describe("sweep of leftover 8gent-voice-* directories", () => {
	const old = (p: string, ageMs: number) => {
		const t = new Date(Date.now() - ageMs);
		utimesSync(p, t, t);
	};
	const mk = (name: string, ageMs: number) => {
		const p = join(root, name);
		mkdirSync(p);
		writeFileSync(join(p, "voice.m4a"), "x");
		old(p, ageMs);
		return p;
	};

	test("removes old directories this user owns; keeps fresh ones, other names, foreign owners and symlinks", () => {
		const stale = mk("8gent-voice-stale", VOICE_DIR_GRACE_MS + 60_000);
		const fresh = mk("8gent-voice-fresh", 5_000);
		const other = mk("something-else", VOICE_DIR_GRACE_MS + 60_000);
		const outside = mkdtempSync(join(tmpdir(), "voice-outside-"));
		writeFileSync(join(outside, "keep.txt"), "keep");
		symlinkSync(outside, join(root, "8gent-voice-link"));

		const removed = sweepVoiceDirs({ tmp: root });
		expect(removed).toEqual([stale]);
		expect(existsSync(stale)).toBe(false);
		expect(existsSync(fresh)).toBe(true);
		expect(existsSync(other)).toBe(true);
		expect(readFileSync(join(outside, "keep.txt"), "utf-8")).toBe("keep");
		rmSync(outside, { recursive: true, force: true });

		// A directory owned by someone else is never touched, however old.
		const mine = statSync(root).uid;
		const foreign = mk("8gent-voice-foreign", VOICE_DIR_GRACE_MS + 60_000);
		expect(sweepVoiceDirs({ tmp: root, uid: mine + 1 })).toEqual([]);
		expect(existsSync(foreign)).toBe(true);
	});

	test("an unreadable temp directory is not an error", () => {
		expect(sweepVoiceDirs({ tmp: join(root, "missing") })).toEqual([]);
	});

	test("startRecording sweeps before it makes its own directory", async () => {
		const order: string[] = [];
		const rec = await startRecording({
			whisperBin: "/fake",
			modelPath: "/fake",
			sweep: () => order.push("sweep"),
			quitSync: () => {},
			makeDir: () => {
				order.push("makeDir");
				return mkdtempSync(join(root, "v-"));
			},
			run: async () => 1,
		});
		expect(order).toEqual(["sweep", "makeDir"]);
		expect("error" in rec).toBe(true);
	});
});

describe("atomic whisper-cli install", () => {
	test("an interrupted copy leaves the old binary whole and no temp file behind", () => {
		const from = join(root, "built");
		const to = join(root, "whisper-cli");
		writeFileSync(from, "NEW-BINARY");
		writeFileSync(to, "OLD-BINARY");
		expect(() =>
			installExecutable(from, to, {
				copy: (_a, b) => {
					writeFileSync(b, "NEW-HALF");
					throw new Error("disk full");
				},
			}),
		).toThrow("disk full");
		expect(readFileSync(to, "utf-8")).toBe("OLD-BINARY");
		expect(readdirSync(root).filter((n) => n.endsWith(".tmp"))).toEqual([]);
	});

	test("the destination never holds a partial file while the copy runs", () => {
		const from = join(root, "built");
		const to = join(root, "whisper-cli");
		writeFileSync(from, "NEW-BINARY");
		const destDuringCopy: boolean[] = [];
		installExecutable(from, to, {
			copy: (a, b) => {
				writeFileSync(b, readFileSync(a));
				destDuringCopy.push(existsSync(to));
			},
		});
		expect(destDuringCopy).toEqual([false]);
		expect(readFileSync(to, "utf-8")).toBe("NEW-BINARY");
		expect(statSync(to).mode & 0o111).not.toBe(0);
		expect(readdirSync(root).filter((n) => n.endsWith(".tmp"))).toEqual([]);
	});

	test("buildWhisper installs through it: executable, in ~/.8gent/bin, no temp left", async () => {
		const env = { HOME: root, EIGHT_HOME: root };
		const work = join(root, "work");
		mkdirSync(work);
		const res = await buildWhisper(
			async (cmd, args, _l, opts) => {
				if (cmd === "cmake" && args[0] === "--build") {
					const out = join(opts?.cwd as string, "build", "bin");
					mkdirSync(out, { recursive: true });
					writeFileSync(join(out, "whisper-cli"), "BUILT");
					chmodSync(join(out, "whisper-cli"), 0o644);
				}
				return 0;
			},
			() => {},
			env,
			{
				workDir: work,
				download: async () => true,
				hash: async () => "ff1a9053feb509ff9d7729703355541ae9690073a6b1c40eb692c962e0dc1720",
			},
		);
		expect(res).toEqual({ path: managedWhisperBin(env) });
		expect(readFileSync(managedWhisperBin(env), "utf-8")).toBe("BUILT");
		expect(statSync(managedWhisperBin(env)).mode & 0o111).not.toBe(0);
		expect(readdirSync(join(root, ".8gent", "bin"))).toEqual(["whisper-cli"]);
	});
});
