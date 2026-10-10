import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { micLine } from "../../apps/tui/src/components/VoiceIndicator.js";
import {
	type CommandRunner,
	describeMissingVoiceSetup,
	describeTranscriberBackend,
	formatMicLabel,
	resolveInputDevice,
} from "./input-device.js";
import { pcm16Level, readTailLevel } from "./recorder.js";

const macJson = (defaultName: string) =>
	JSON.stringify({
		SPAudioDataType: [
			{
				_items: [
					{ _name: "MacBook Pro Speakers", coreaudio_default_audio_output_device: "spaudio_yes" },
					{ _name: "MacBook Pro Microphone" },
					{ _name: defaultName, coreaudio_default_audio_input_device: "spaudio_yes" },
				],
			},
		],
	});

describe("resolveInputDevice", () => {
	test("macOS reads the default input from system_profiler", async () => {
		const run: CommandRunner = async (cmd) => (cmd[0] === "system_profiler" ? macJson("AirPods Pro") : null);
		expect(await resolveInputDevice({ platform: "darwin", run })).toEqual({
			name: "AirPods Pro",
			source: "system_profiler",
		});
	});

	test("Linux uses the pactl description, falling back to the source name", async () => {
		const listing = "Source #1\n\tName: alsa_input.usb-Blue\n\tDescription: Blue Yeti\n\nSource #2\n\tName: other\n\tDescription: Other\n";
		const withList: CommandRunner = async (cmd) =>
			cmd[1] === "get-default-source" ? "alsa_input.usb-Blue\n" : listing;
		expect((await resolveInputDevice({ platform: "linux", run: withList })).name).toBe("Blue Yeti");
		const noList: CommandRunner = async (cmd) =>
			cmd[1] === "get-default-source" ? "alsa_input.usb-Blue\n" : null;
		expect((await resolveInputDevice({ platform: "linux", run: noList })).name).toBe("alsa_input.usb-Blue");
	});

	test("Windows takes the first line of PowerShell output", async () => {
		const run: CommandRunner = async () => "Headset Microphone (Jabra)\r\n";
		expect(await resolveInputDevice({ platform: "win32", run })).toEqual({
			name: "Headset Microphone (Jabra)",
			source: "powershell",
		});
	});

	test("falls back to unknown on failure, bad JSON, or unsupported OS", async () => {
		const fail: CommandRunner = async () => null;
		const bad: CommandRunner = async () => "not json";
		const boom: CommandRunner = async () => {
			throw new Error("x");
		};
		for (const platform of ["darwin", "linux", "win32"] as const) {
			expect((await resolveInputDevice({ platform, run: fail })).name).toBeNull();
		}
		expect((await resolveInputDevice({ platform: "darwin", run: bad })).name).toBeNull();
		expect((await resolveInputDevice({ platform: "linux", run: boom })).name).toBeNull();
		expect((await resolveInputDevice({ platform: "freebsd", run: fail })).source).toBe("unknown");
	});

	test("never caches: each call re-queries the OS", async () => {
		let current = "Built-in Microphone";
		let calls = 0;
		const run: CommandRunner = async () => {
			calls++;
			return macJson(current);
		};
		expect((await resolveInputDevice({ platform: "darwin", run })).name).toBe("Built-in Microphone");
		current = "AirPods Pro";
		expect((await resolveInputDevice({ platform: "darwin", run })).name).toBe("AirPods Pro");
		expect(calls).toBe(2);
	});
});

describe("indicator text", () => {
	test("mic label and combined line", () => {
		expect(formatMicLabel({ name: "AirPods Pro", source: "system_profiler" })).toBe("Mic: AirPods Pro");
		expect(formatMicLabel(null)).toBe("Mic: unknown device");
		expect(micLine("Blue Yeti", "Transcriber: whisper.cpp local (tiny)")).toBe(
			"Mic: Blue Yeti | Transcriber: whisper.cpp local (tiny)",
		);
		expect(micLine(null)).toBe("Mic: unknown device");
	});
});

describe("setup check", () => {
	const base = { soxPath: "/x/rec", whisperBinaryPath: "/x/w", downloadedModels: ["tiny"], modelsDir: "/m", platform: "darwin" as const };
	test("nothing missing gives no lines", () => {
		expect(describeMissingVoiceSetup(base)).toEqual([]);
	});
	test("one line per missing piece", () => {
		const lines = describeMissingVoiceSetup({ ...base, soxPath: null, whisperBinaryPath: null, downloadedModels: [] });
		expect(lines).toHaveLength(3);
		expect(lines[0]).toContain("brew install sox");
		expect(lines[1]).toContain("whisper.cpp");
		expect(lines[2]).toContain("/m");
	});
	test("backend label", () => {
		expect(describeTranscriberBackend({ whisperBinaryPath: "/w", downloadedModels: ["base"] })).toBe(
			"Transcriber: whisper.cpp local (base)",
		);
		expect(describeTranscriberBackend({ whisperBinaryPath: null, downloadedModels: [], cloudAvailable: true })).toContain("cloud");
		expect(describeTranscriberBackend({ whisperBinaryPath: null, downloadedModels: [] })).toContain("none");
	});
});

describe("real input levels", () => {
	const dirs: string[] = [];
	afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
	test("silence reads 0 and a loud signal reads high", () => {
		expect(pcm16Level(new Uint8Array(200))).toBe(0);
		const loud = Buffer.alloc(200);
		for (let i = 0; i < 100; i++) loud.writeInt16LE(i % 2 ? 20000 : -20000, i * 2);
		expect(pcm16Level(loud)).toBeGreaterThan(0.9);
	});
	test("reads the tail of a growing WAV, null before data exists", () => {
		const dir = mkdtempSync(join(tmpdir(), "lvl-"));
		dirs.push(dir);
		const f = join(dir, "a.wav");
		writeFileSync(f, Buffer.alloc(44));
		expect(readTailLevel(f)).toBeNull();
		const pcm = Buffer.alloc(3200);
		for (let i = 0; i < 1600; i++) pcm.writeInt16LE(8000, i * 2);
		writeFileSync(f, Buffer.concat([Buffer.alloc(44), pcm]));
		expect(readTailLevel(f)).toBeGreaterThan(0.5);
	});
});
