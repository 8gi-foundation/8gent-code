/**
 * #5245: on the day8 channel `/dj play <query>` returns the audio in the turn result instead of playing on the host.
 * Real gateway, real WebSocket, the real fetchDjAudio; only yt-dlp is a stand-in script on PATH.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DJ_AUDIO_MAX_BYTES, fetchDjAudio } from "../music/dj-fetch";
import { type AgentPool, KNOWN_CHANNELS } from "./agent-pool";
import { startGateway } from "./gateway";

const chatted: string[] = [];
class StubPool {
	live = new Map<string, string>();
	get size() {
		return this.live.size;
	}
	createSession(id: string, channel: string) {
		this.live.set(id, channel);
	}
	hasSession(id: string) {
		return this.live.has(id);
	}
	destroySession(id: string) {
		this.live.delete(id);
	}
	getAgent(id: string) {
		return this.live.has(id) ? { getModel: () => "m", getRuntime: () => "rt" } : null;
	}
	getSessionInfo(id: string) {
		return this.live.has(id)
			? { channel: this.live.get(id), messageCount: 0, busy: false, createdAt: 1, lastActiveAt: 2 }
			: null;
	}
	getActiveSessions() {
		return [];
	}
	getStatus() {
		return {};
	}
	canCreate() {
		return true;
	}
	abort() {
		return false;
	}
	async chat(_sid: string, text: string): Promise<string> {
		chatted.push(text);
		return "model";
	}
}

type Frame = Record<string, any>;
const pool = new StubPool();
let server: ReturnType<typeof Bun.serve>;
let tmp: string;
const saved = {
	path: process.env.PATH,
	data: process.env.EIGHT_DATA_DIR,
	home: process.env.EIGHT_HOME,
};

// A stand-in yt-dlp: records its arguments, writes one file where -o says, prints the title. YT_MODE picks the behaviour.
const FAKE = `#!/bin/sh
echo "$@" >> "$FAKE_LOG"
out=""
while [ $# -gt 0 ]; do [ "$1" = "-o" ] && out="$2"; shift; done
case "$YT_MODE" in
  fail) exit 1 ;;
  big) head -c ${DJ_AUDIO_MAX_BYTES + 10} /dev/zero > "$(echo "$out" | sed 's/%(ext)s/m4a/')" ;;
  *) printf 'fake-m4a-audio' > "$(echo "$out" | sed 's/%(ext)s/m4a/')" ;;
esac
echo "Daft Punk - Around The World"
`;

beforeAll(() => {
	tmp = mkdtempSync(join(tmpdir(), "dj-day8-"));
	writeFileSync(join(tmp, "yt-dlp"), FAKE);
	chmodSync(join(tmp, "yt-dlp"), 0o755);
	process.env.PATH = `${tmp}:${saved.path}`;
	process.env.FAKE_LOG = join(tmp, "calls.log");
	process.env.EIGHT_DATA_DIR = join(tmp, "data");
	process.env.EIGHT_HOME = join(tmp, "home"); // no managed yt-dlp here: the PATH one is what is found
	process.env.DAEMON_HOSTNAME = "127.0.0.1";
	server = startGateway({ port: 0, authToken: null, pool: pool as unknown as AgentPool });
});

afterAll(() => {
	server.stop(true);
	process.env.PATH = saved.path;
	if (saved.data === undefined) Reflect.deleteProperty(process.env, "EIGHT_DATA_DIR");
	else process.env.EIGHT_DATA_DIR = saved.data;
	if (saved.home === undefined) Reflect.deleteProperty(process.env, "EIGHT_HOME");
	else process.env.EIGHT_HOME = saved.home;
	rmSync(tmp, { recursive: true, force: true });
});

async function turn(channel: string, text: string) {
	const frames: Frame[] = [];
	const ws = new WebSocket(`ws://127.0.0.1:${server.port}`);
	ws.onmessage = (ev) => frames.push(JSON.parse(String(ev.data)));
	await new Promise((r) => {
		ws.onopen = () => r(null);
	});
	ws.send(JSON.stringify({ type: "session:create", channel }));
	const wait = async (pred: (f: Frame) => boolean) => {
		for (let i = 0; i < 300; i++) {
			const f = frames.find(pred);
			if (f) return f;
			await new Promise((r) => setTimeout(r, 10));
		}
		throw new Error(
			`no frame; saw ${JSON.stringify(frames.map((f) => f.type + (f.event ? `:${f.event}` : "")))}`,
		);
	};
	await wait((f) => f.type === "session:created");
	ws.send(JSON.stringify({ type: "prompt", text }));
	const stream = await wait(
		(f) => f.type === "event" && f.event === "agent:stream" && f.payload?.final === true,
	);
	await wait((f) => f.type === "event" && f.event === "session:end");
	ws.close();
	return stream.payload as { chunk: string; audio?: { mime: string; base64: string } };
}

describe("/dj play on the day8 channel", () => {
	it("knows the channel", () => {
		expect(KNOWN_CHANNELS).toContain("day8");
	});

	it("returns the title and the audio bytes in the turn result, and never reaches the model", async () => {
		process.env.YT_MODE = "ok";
		const p = await turn("day8", "/dj play daft punk around the world");
		expect(p.chunk).toBe("Daft Punk - Around The World");
		expect(p.audio?.mime).toBe("audio/mp4");
		expect(Buffer.from(p.audio!.base64, "base64").toString()).toBe("fake-m4a-audio");
		expect(chatted).toEqual([]);
	});

	it("runs the tool with no shell on one ytsearch1 argument, audio only, size-capped", async () => {
		process.env.YT_MODE = "ok";
		await turn("day8", "/dj play x; echo pwned $(id) --exec evil");
		const last = readFileSync(join(tmp, "calls.log"), "utf8").trim().split("\n").pop()!;
		expect(last).toContain("ytsearch1:x; echo pwned $(id) --exec evil");
		expect(last).toContain("--no-playlist");
		expect(last).toContain("--ignore-config");
		expect(last).toContain(`--max-filesize ${DJ_AUDIO_MAX_BYTES}`);
		expect(last).not.toContain("--exec evil ytsearch1"); // the words stayed inside the one search argument
	});

	it("a URL in the query is search text, not a fetch", async () => {
		process.env.YT_MODE = "ok";
		await turn("day8", "/dj play http://169.254.169.254/latest/meta-data");
		const last = readFileSync(join(tmp, "calls.log"), "utf8").trim().split("\n").pop()!;
		expect(last.endsWith("ytsearch1:http://169.254.169.254/latest/meta-data")).toBe(true);
	});

	it("a failing or over-size fetch is a plain line with no audio", async () => {
		process.env.YT_MODE = "fail";
		const a = await turn("day8", "/dj play nothing");
		expect(a.audio).toBeUndefined();
		expect(a.chunk).toBe("could not find that song");
		process.env.YT_MODE = "big";
		const b = await turn("day8", "/dj play huge");
		expect(b.audio).toBeUndefined();
		expect(b.chunk).toBe("that track is too long to send");
	});

	it("leaves no temp directory behind", async () => {
		process.env.YT_MODE = "ok";
		const before = readdirSync(tmpdir()).filter((f) => f.startsWith("dj-audio-")).length;
		await turn("day8", "/dj play again");
		expect(readdirSync(tmpdir()).filter((f) => f.startsWith("dj-audio-")).length).toBe(before);
	});

	it("other /dj subcommands and other channels are unchanged: no audio, no fetch", async () => {
		process.env.YT_MODE = "ok";
		const calls = () => (readFileSync(join(tmp, "calls.log"), "utf8").match(/\n/g) ?? []).length;
		const n = calls();
		const s = await turn("day8", "/dj status");
		expect(s.audio).toBeUndefined();
		expect(calls()).toBe(n);
	});
});

describe("fetchDjAudio with no tool", () => {
	it("says so plainly and installs nothing", async () => {
		const r = await fetchDjAudio("x", { findTool: () => null, run: async () => "" });
		expect(r).toEqual({ ok: false, reason: "yt-dlp not installed on this vessel" });
	});
	it("refuses an empty or over-long query before looking for the tool", async () => {
		let looked = false;
		const io = {
			findTool: () => {
				looked = true;
				return null;
			},
			run: async () => "",
		};
		expect((await fetchDjAudio("   ", io)).ok).toBe(false);
		expect((await fetchDjAudio("x".repeat(201), io)).ok).toBe(false);
		expect(looked).toBe(false);
	});
});
