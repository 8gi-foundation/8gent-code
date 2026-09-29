import { describe, expect, test } from "bun:test";
import { installHint, mpvIpcPath, parseMpvReply, pickResolved, whichCommand } from "../dj";

describe("DJ platform helpers", () => {
	test("mpv IPC uses a named pipe on Windows", () => {
		expect(mpvIpcPath("win32", "C:\\Users\\a\\AppData\\Local\\Temp", 42)).toBe(
			"\\\\.\\pipe\\mpv-8gent-dj-42",
		);
	});

	test("mpv IPC uses a unix socket in tmp elsewhere", () => {
		expect(mpvIpcPath("darwin", "/tmp", 42)).toBe("/tmp/mpv-8gent-dj-42.sock");
		expect(mpvIpcPath("linux", "/tmp", 42)).toBe("/tmp/mpv-8gent-dj-42.sock");
	});

	test("two sessions get separate endpoints", () => {
		expect(mpvIpcPath("darwin", "/tmp", 1)).not.toBe(mpvIpcPath("darwin", "/tmp", 2));
	});

	test("PATH lookup uses where.exe on Windows, never a POSIX shell", () => {
		expect(whichCommand("mpv", "win32")).toEqual(["where.exe", ["mpv"]]);
	});

	test("PATH lookup passes the name as an argument, not interpolated", () => {
		const name = 'x"; echo injected; "';
		const [bin, args] = whichCommand(name, "darwin");
		expect(bin).toBe("/bin/sh");
		expect(args[1]).toBe('command -v "$1"');
		expect(args[3]).toBe(name);
	});

	test("where.exe output prefers a spawnable .exe or .com over a .cmd shim", () => {
		const out = "C:\\tools\\yt-dlp.cmd\r\nC:\\Users\\a\\scoop\\shims\\yt-dlp.exe\r\n";
		expect(pickResolved(out)).toBe("C:\\Users\\a\\scoop\\shims\\yt-dlp.exe");
	});

	test("lookup output falls back to the first line, and empty is null", () => {
		expect(pickResolved("/opt/homebrew/bin/mpv\n")).toBe("/opt/homebrew/bin/mpv");
		expect(pickResolved("")).toBeNull();
	});

	test("install hint matches the platform's package manager", () => {
		expect(installHint("win32")).toContain("scoop install mpv yt-dlp ffmpeg sox");
		expect(installHint("linux")).toContain("apt install");
		expect(installHint("darwin")).toBe("brew install mpv yt-dlp ffmpeg sox");
	});

	test("mpv reply is found among interleaved event lines", () => {
		const buf = '{"event":"playback-restart"}\n{"data":42.5,"request_id":0,"error":"success"}\n';
		expect(parseMpvReply(buf)).toEqual({ complete: true, data: 42.5 });
	});

	test("mpv reply waits for a complete line", () => {
		expect(parseMpvReply('{"data":42.5,"requ').complete).toBe(false);
	});

	test("mpv error reply resolves to null", () => {
		expect(parseMpvReply('{"request_id":0,"error":"property unavailable"}\n')).toEqual({
			complete: true,
			data: null,
		});
	});
});
