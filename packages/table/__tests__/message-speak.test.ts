/**
 * message-speak.ts tests: voice selection, ephemeral synthesis (temp file
 * never survives the call), and the HTTP handler's status mapping + read
 * authority. Most cases inject a fake narrate/voiceFor pair so the suite runs
 * fast without shelling out; one test (guarded by findSupertonic()) exercises
 * the REAL supertonic binary end to end to prove the plumbing actually
 * produces audio, not just that the types line up.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Ledger } from "../../goal/ledger.js";
import { findSupertonic, HUMAN_VOICE, voiceFor } from "../huddle-voice.js";
import {
	SPEAK_URL_RE,
	handleTableSpeakHttp,
	synthesizeMessageSpeech,
	voiceForAuthor,
	type SynthesizeDeps,
} from "../message-speak.js";
import { TableStore } from "../store.js";

const TEST_KEY = Buffer.from("b".repeat(64), "hex");

describe("voiceForAuthor", () => {
	it("resolves an agent author to its officer voice", () => {
		const seen: string[] = [];
		const fakeVoiceFor = (code: string) => {
			seen.push(code);
			return voiceFor(code);
		};
		const v = voiceForAuthor("agent:8TO", fakeVoiceFor);
		expect(seen).toEqual(["8TO"]);
		expect(v).toEqual(voiceFor("8TO"));
	});

	it("falls back to HUMAN_VOICE for any human author", () => {
		expect(voiceForAuthor("human:local", voiceFor)).toEqual(HUMAN_VOICE);
		expect(voiceForAuthor("human:james", voiceFor)).toEqual(HUMAN_VOICE);
	});
});

describe("synthesizeMessageSpeech (injected deps - fast, no real TTS)", () => {
	function fakeDeps(behavior: "success" | "empty_text" | "no_tts" | "tts_failed"): {
		deps: SynthesizeDeps;
		writtenDirs: string[];
	} {
		const writtenDirs: string[] = [];
		const deps: SynthesizeDeps = {
			voiceFor: () => HUMAN_VOICE,
			narrate: (opts) => {
				writtenDirs.push(path.dirname(opts.outPath));
				if (behavior === "success") {
					fs.writeFileSync(opts.outPath, Buffer.from("RIFF....WAVEfmt fake-wav-bytes"));
					return { audioPath: opts.outPath, durationMs: 1234 };
				}
				return { audioPath: null, durationMs: 900, skipped: behavior };
			},
		};
		return { deps, writtenDirs };
	}

	it("returns the synthesized bytes and duration on success, and cleans up the temp dir", async () => {
		const { deps, writtenDirs } = fakeDeps("success");
		const result = await synthesizeMessageSpeech(
			{ content: "hello table", authorId: "human:local" },
			deps,
		);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.bytes.toString()).toContain("fake-wav-bytes");
			expect(result.durationMs).toBe(1234);
		}
		// Ephemeral, always: the temp dir narrate() wrote into must be gone.
		expect(writtenDirs.length).toBe(1);
		expect(fs.existsSync(writtenDirs[0])).toBe(false);
	});

	it("maps empty_text/no_tts/tts_failed through, and still cleans up on failure", async () => {
		for (const behavior of ["empty_text", "no_tts", "tts_failed"] as const) {
			const { deps, writtenDirs } = fakeDeps(behavior);
			const result = await synthesizeMessageSpeech(
				{ content: "x", authorId: "human:local" },
				deps,
			);
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.reason).toBe(behavior);
			expect(fs.existsSync(writtenDirs[0])).toBe(false);
		}
	});
});

describe("SPEAK_URL_RE", () => {
	it("matches the messageId charset and captures it", () => {
		const m = SPEAK_URL_RE.exec("/table/messages/msg_abc123/speak");
		expect(m?.[1]).toBe("msg_abc123");
		expect(SPEAK_URL_RE.test("/table/messages/msg_abc123/edit")).toBe(false);
		expect(SPEAK_URL_RE.test("/table/messages//speak")).toBe(false);
	});
});

describe("handleTableSpeakHttp", () => {
	let tmpDir: string;
	let store: TableStore;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "table-speak-http-"));
		const ledger = Ledger.open({ runId: "ledger", baseDir: tmpDir, key: TEST_KEY });
		store = new TableStore({ dbPath: path.join(tmpDir, "table.db"), ledger });
	});

	afterEach(() => {
		store.close();
		try {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		} catch {
			// best effort
		}
	});

	function successDeps(bytes = "RIFF-fake-wav"): SynthesizeDeps {
		return {
			voiceFor: () => HUMAN_VOICE,
			narrate: (opts) => {
				fs.writeFileSync(opts.outPath, Buffer.from(bytes));
				return { audioPath: opts.outPath, durationMs: 4200 };
			},
		};
	}

	it("returns null (falls through) for a non-POST method", async () => {
		const req = new Request("http://x/table/messages/msg_1/speak", { method: "GET" });
		const res = await handleTableSpeakHttp(req, new URL(req.url), store);
		expect(res).toBeNull();
	});

	it("returns null (falls through) for a non-matching path", async () => {
		const req = new Request("http://x/table/channels/ch1/messages", { method: "POST" });
		const res = await handleTableSpeakHttp(req, new URL(req.url), store);
		expect(res).toBeNull();
	});

	it("404s when the message does not exist", async () => {
		const req = new Request("http://x/table/messages/msg_missing/speak", { method: "POST" });
		const res = await handleTableSpeakHttp(req, new URL(req.url), store);
		expect(res?.status).toBe(404);
	});

	it("404s a soft-deleted message", async () => {
		const c = store.createChannel({
			name: "design", type: "stream", visibility: "open", createdBy: "human:local",
		});
		const m = store.postMessage({ channelId: c.id, authorId: "human:local", content: "bye" });
		store.deleteMessage({ messageId: m.id, deleterId: "human:local" });
		const req = new Request(`http://x/table/messages/${m.id}/speak`, { method: "POST" });
		const res = await handleTableSpeakHttp(req, new URL(req.url), store);
		expect(res?.status).toBe(404);
	});

	it("403s a private channel human:local is not a member of - never leaks content", async () => {
		const priv = store.createChannel({
			name: "priv", type: "stream", visibility: "private", createdBy: "human:someone-else",
		});
		const m = store.postMessage({
			channelId: priv.id, authorId: "human:someone-else", content: "classified",
		});
		const req = new Request(`http://x/table/messages/${m.id}/speak`, { method: "POST" });
		const res = await handleTableSpeakHttp(req, new URL(req.url), store, successDeps());
		expect(res?.status).toBe(403);
	});

	it("200s with real audio bytes for a message an open channel's viewer may read", async () => {
		const c = store.createChannel({
			name: "design", type: "stream", visibility: "open", createdBy: "human:local",
		});
		const m = store.postMessage({ channelId: c.id, authorId: "human:local", content: "read me aloud" });
		const req = new Request(`http://x/table/messages/${m.id}/speak`, { method: "POST" });
		const res = await handleTableSpeakHttp(req, new URL(req.url), store, successDeps("audio-bytes-here"));
		expect(res?.status).toBe(200);
		expect(res?.headers.get("content-type")).toBe("audio/wav");
		expect(res?.headers.get("x-speech-duration-ms")).toBe("4200");
		const body = await res!.text();
		expect(body).toBe("audio-bytes-here");
	});

	it("maps a synthesis failure to an honest, non-200 status", async () => {
		const c = store.createChannel({
			name: "design", type: "stream", visibility: "open", createdBy: "human:local",
		});
		const m = store.postMessage({ channelId: c.id, authorId: "human:local", content: "x" });
		const failDeps: SynthesizeDeps = {
			voiceFor: () => HUMAN_VOICE,
			narrate: () => ({ audioPath: null, durationMs: 900, skipped: "tts_failed" }),
		};
		const req = new Request(`http://x/table/messages/${m.id}/speak`, { method: "POST" });
		const res = await handleTableSpeakHttp(req, new URL(req.url), store, failDeps);
		expect(res?.status).toBe(503);
	});
});

// --------------------------------------------------------------------------- #
// Real end-to-end: the actual supertonic binary, actually invoked, actually
// producing wav bytes - proves the reused huddle-voice.ts call path really
// works from this new caller, not just that the fakes above are self-
// consistent. Skips (never fails) when supertonic is not installed, so CI
// boxes without it still pass the fast suite above.
// --------------------------------------------------------------------------- #
const supertonicBin = findSupertonic();
const realIt = supertonicBin ? it : it.skip;

describe("synthesizeMessageSpeech (REAL supertonic, default deps)", () => {
	realIt(
		"produces genuine, playable wav bytes for a short message and leaves no temp file behind",
		async () => {
			const before = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("table-speak-"));
			const result = await synthesizeMessageSpeech({
				content: "Testing message speech.",
				authorId: "human:local",
			});
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.bytes.length).toBeGreaterThan(44); // real WAV header + data
				expect(result.bytes.subarray(0, 4).toString("ascii")).toBe("RIFF");
				expect(result.bytes.subarray(8, 12).toString("ascii")).toBe("WAVE");
				expect(result.durationMs).toBeGreaterThan(0);
			}
			const after = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("table-speak-"));
			expect(after).toEqual(before); // nothing new left behind
		},
		30_000,
	);
});
