/**
 * Heard-only voice memory (#3428), behind EIGHT_VOICE_HEARD_ONLY=1.
 *
 * When a spoken reply is cut off, the loop reports only the sentence chunks
 * that finished playing, so the caller can trim the stored reply. The metric
 * from the issue: across 10 scripted interruptions, the text handed back for
 * history never contains a sentence the user did not hear (target 0).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { Agent } from "../eight/agent";
import { TTSEngine, type TTSProcess, getTTSEngine, setTTSEngine } from "./tts-engine";
import {
	HEARD_ONLY_MARK,
	VoiceChatLoop,
	VoiceReplyTracker,
	heardOnlyText,
	isHeardOnlyEnabled,
} from "./voice-chat";

// Three sentences with unique tokens, each long enough (over 60 chars) to be its own TTS chunk, so "did unheard text leak" is a string check.
const S1 = "Alpha one is here, the first of three points, and it runs long enough to fill a chunk.";
const S2 = "Bravo two follows, the second point, also long enough that it needs its own chunk.";
const S3 = "Charlie three ends the reply, the last point, again long enough for a chunk alone.";
const REPLY = `${S1} ${S2} ${S3}`;
const CHUNKS = [S1, S2, S3];
const TOKENS = ["Alpha", "Bravo", "Charlie"];

type Step =
	| "finish"
	| "interrupt"
	| "stop"
	| "throw"
	| "finish-then-interrupt"
	| "interrupt-before-start"
	| "stop-before-start";

/** A TTS engine whose chunks finish or get cut off on a script, no audio involved. */
class ScriptedTTS extends TTSEngine {
	spoken: string[] = [];
	loop: VoiceChatLoop | null = null;
	constructor(private script: Step[]) {
		super();
	}
	async speak(text: string): Promise<TTSProcess> {
		const step = this.script[this.spoken.length] ?? "finish";
		this.spoken.push(text);
		const loop = this.loop as VoiceChatLoop;
		if (step === "throw") throw new Error("tts failed");
		// Interrupt lands after the previous chunk ended and before this one plays.
		if (step === "interrupt-before-start") await loop.interrupt();
		if (step === "stop-before-start") await loop.stop();
		let done: (code: number) => void = () => {};
		const exited = new Promise<number>((r) => {
			done = r;
		});
		const proc: TTSProcess = { kill: () => done(143), exited };
		if (step === "finish" || step === "interrupt-before-start" || step === "stop-before-start")
			queueMicrotask(() => done(0));
		if (step === "finish-then-interrupt") {
			// Chunk ends and the interrupt arrives in the same tick.
			exited.then(() => loop.interrupt());
			queueMicrotask(() => done(0));
		}
		if (step === "interrupt") setTimeout(() => loop.interrupt(), 0);
		if (step === "stop") setTimeout(() => loop.stop(), 0);
		return proc;
	}
	async interrupt(): Promise<void> {}
}

interface Run {
	heard: string[];
	said: string[];
	spoken: string[];
}

/** Drive one turn (listen stubbed) with the given script and flag. */
async function runTurn(
	script: Step[],
	heardOnly: boolean,
	reply = REPLY,
	opts: { onMessage?: (t: string) => Promise<string>; onHeard?: (h: string) => void } = {},
): Promise<Run> {
	const tts = new ScriptedTTS(script);
	setTTSEngine(tts);
	const loop = new VoiceChatLoop({
		engine: {} as never,
		onMessage: opts.onMessage ?? (async () => reply),
		heardOnly,
	});
	tts.loop = loop;
	const heard: string[] = [];
	const said: string[] = [];
	loop.on("agent-heard", (t) => heard.push(t));
	if (opts.onHeard) loop.on("agent-heard", opts.onHeard);
	loop.on("agent-said", (t) => said.push(t));
	const internals = loop as unknown as {
		running: boolean;
		listenForSpeech: () => Promise<string>;
		runOneTurn: () => Promise<void>;
	};
	internals.running = true;
	internals.listenForSpeech = async () => "tell me three things";
	await internals.runOneTurn();
	return { heard, said, spoken: tts.spoken };
}

function leaksUnheard(text: string, heardCount: number): boolean {
	return TOKENS.slice(heardCount).some((t) => text.includes(t));
}

const original = getTTSEngine();
afterEach(() => setTTSEngine(original));

describe("heardOnlyText", () => {
	test("full playback leaves history alone", () => {
		expect(heardOnlyText(CHUNKS, 3)).toBeNull();
	});
	test("partial playback keeps the heard chunks and marks the cut", () => {
		expect(heardOnlyText(CHUNKS, 2)).toBe(`${S1} ${S2} ${HEARD_ONLY_MARK}`);
	});
	test("nothing heard keeps only the mark", () => {
		expect(heardOnlyText(CHUNKS, 0)).toBe(HEARD_ONLY_MARK);
	});
});

describe("isHeardOnlyEnabled", () => {
	test("on only for exactly 1", () => {
		expect(isHeardOnlyEnabled({ EIGHT_VOICE_HEARD_ONLY: "1" })).toBe(true);
		expect(isHeardOnlyEnabled({})).toBe(false);
		expect(isHeardOnlyEnabled({ EIGHT_VOICE_HEARD_ONLY: "0" })).toBe(false);
		expect(isHeardOnlyEnabled({ EIGHT_VOICE_HEARD_ONLY: "true" })).toBe(false);
	});
});

// The 10 scripted interruptions. expected = text handed back for history, null = no change.
const SCENARIOS: Array<{ name: string; script: Step[]; heardCount: number; reply?: string }> = [
	{ name: "1. interrupt during the first chunk", script: ["interrupt"], heardCount: 0 },
	{
		name: "2. interrupt mid reply, during chunk 2",
		script: ["finish", "interrupt"],
		heardCount: 1,
	},
	{
		name: "3. interrupt during the last chunk",
		script: ["finish", "finish", "interrupt"],
		heardCount: 2,
	},
	{
		name: "4. interrupt between chunks 1 and 2",
		script: ["finish", "interrupt-before-start"],
		heardCount: 1,
	},
	{
		name: "5. interrupt between chunks 2 and 3",
		script: ["finish", "finish", "interrupt-before-start"],
		heardCount: 2,
	},
	{ name: "6. stop() during chunk 2", script: ["finish", "stop"], heardCount: 1 },
	{
		name: "7. stop() between chunks 2 and 3",
		script: ["finish", "finish", "stop-before-start"],
		heardCount: 2,
	},
	{
		name: "8. chunk 1 ends in the same tick as the interrupt (counted unheard)",
		script: ["finish-then-interrupt"],
		heardCount: 0,
	},
	{
		name: "9. single-chunk reply cut off",
		script: ["interrupt"],
		heardCount: 0,
		reply: "Alpha one is the only thing.",
	},
	{
		name: "10. markdown reply cut during chunk 2",
		script: ["finish", "interrupt"],
		heardCount: 1,
		reply: `**Alpha** one is \`here\`, the first of three points, and it runs long enough to fill a chunk. ${S2} ${S3}`,
	},
];

describe("10 scripted interruptions, flag on", () => {
	for (const s of SCENARIOS) {
		test(s.name, async () => {
			const run = await runTurn(s.script, true, s.reply);
			expect(run.heard).toHaveLength(1);
			const text = run.heard[0] as string;
			expect(text.endsWith(HEARD_ONLY_MARK)).toBe(true);
			expect(text).not.toContain("**");
			const expectedPrefix = run.spoken.slice(0, s.heardCount).join(" ");
			expect(text).toBe(expectedPrefix ? `${expectedPrefix} ${HEARD_ONLY_MARK}` : HEARD_ONLY_MARK);
			expect(leaksUnheard(text, s.heardCount)).toBe(false);
			// agent-said still carries the full reply; the trim is a separate signal.
			expect(run.said).toEqual([s.reply ?? REPLY]);
		});
	}

	test("interrupt after the last chunk finished: no change", async () => {
		const run = await runTurn(["finish", "finish", "finish"], true);
		expect(run.heard).toEqual([]);
		expect(run.spoken).toEqual(CHUNKS);
	});

	test("an interrupt stops the rest of the reply from playing", async () => {
		const run = await runTurn(["finish", "interrupt-before-start"], true);
		expect(run.spoken).toEqual(CHUNKS.slice(0, 2));
		const mid = await runTurn(["finish", "interrupt"], true);
		expect(mid.spoken).toEqual(CHUNKS.slice(0, 2));
	});

	test("a TTS failure is not a cut-off: no change to history", async () => {
		const run = await runTurn(["finish", "throw"], true);
		expect(run.heard).toEqual([]);
		expect(run.said).toEqual([REPLY]);
		const first = await runTurn(["throw"], true);
		expect(first.heard).toEqual([]);
	});

	test("metric: 0 of 10 interruptions keep text the user did not hear", async () => {
		let leaks = 0;
		for (const s of SCENARIOS) {
			const run = await runTurn(s.script, true, s.reply);
			if (leaksUnheard(run.heard[0] ?? "", s.heardCount)) leaks++;
		}
		expect(leaks).toBe(0);
	});
});

describe("flag off: unchanged", () => {
	test("no agent-heard event and the legacy chunk sequence for every scenario", async () => {
		for (const s of SCENARIOS) {
			const run = await runTurn(s.script, false, s.reply);
			expect(run.heard).toEqual([]);
			expect(run.said).toEqual([s.reply ?? REPLY]);
		}
	});

	test("legacy behaviour kept: an interrupt cuts one chunk and later chunks still play", async () => {
		const between = await runTurn(["finish", "interrupt-before-start"], false);
		expect(between.spoken).toEqual(CHUNKS);
		expect(between.heard).toEqual([]);
		const mid = await runTurn(["finish", "interrupt"], false);
		expect(mid.spoken).toEqual(CHUNKS);
		expect(mid.heard).toEqual([]);
	});

	test("default comes from EIGHT_VOICE_HEARD_ONLY and is off when unset", async () => {
		const prev = process.env.EIGHT_VOICE_HEARD_ONLY;
		Reflect.deleteProperty(process.env, "EIGHT_VOICE_HEARD_ONLY");
		try {
			const tts = new ScriptedTTS(["finish", "interrupt"]);
			setTTSEngine(tts);
			const loop = new VoiceChatLoop({ engine: {} as never, onMessage: async () => REPLY });
			tts.loop = loop;
			const heard: string[] = [];
			loop.on("agent-heard", (t) => heard.push(t));
			const internals = loop as unknown as {
				running: boolean;
				speakText: (t: string) => Promise<void>;
			};
			internals.running = true;
			await internals.speakText(REPLY);
			expect(heard).toEqual([]);
		} finally {
			if (prev !== undefined) process.env.EIGHT_VOICE_HEARD_ONLY = prev;
		}
	});
});

type Msg = { role: string; content: string };

function makeAgent(history: Msg[]): Agent {
	const agent = new Agent({ model: "eight-1.0-q3:14b", runtime: "ollama" });
	agent.restoreFromCheckpoint(history);
	return agent;
}

function contents(agent: Agent): string[] {
	return agent
		.getMessageHistory()
		.filter((m) => m.role !== "system")
		.map((m) => m.content);
}

/** chat() stand-in that pushes the user turn and the reply, as the real one does. */
function pushTurn(agent: Agent, user: string, reply: string): void {
	const h = (agent as unknown as { messageHistory: Msg[] }).messageHistory;
	h.push({ role: "user", content: user });
	h.push({ role: "assistant", content: reply });
}

/** The app.tsx voice turn shape: begin, chat, commit only on success, spoken error otherwise. */
function voiceTurn(
	agent: Agent | null,
	tracker: VoiceReplyTracker,
	chat: (t: string) => Promise<string>,
	opts: { approve?: (draft: string) => Promise<boolean>; beforeCommit?: () => void } = {},
) {
	return async (t: string): Promise<string> => {
		tracker.begin(agent);
		if (!agent) return "Agent not ready.";
		try {
			let r = await chat(t);
			// The critic pass: a rejected draft triggers a second chat, as app.tsx does.
			if (opts.approve && !(await opts.approve(r))) r = await chat(`${t}\n\n[critique]`);
			opts.beforeCommit?.();
			tracker.commit(agent, r);
			return r;
		} catch (err) {
			return `Error: ${(err as Error).message}`;
		}
	};
}

const PREVIOUS: Msg[] = [
	{ role: "user", content: "earlier question" },
	{ role: "assistant", content: "previous answer" },
];

describe("only amend the reply this voice turn produced", () => {
	test("success: the cut-off reply is trimmed to what was heard", async () => {
		const agent = makeAgent(PREVIOUS);
		const tracker = new VoiceReplyTracker();
		const amended: boolean[] = [];
		await runTurn(["finish", "interrupt"], true, REPLY, {
			onMessage: voiceTurn(agent, tracker, async (t) => {
				pushTurn(agent, t, REPLY);
				return REPLY;
			}),
			onHeard: (h) => amended.push(tracker.amend(agent, h)),
		});
		expect(amended).toEqual([true]);
		expect(contents(agent)).toEqual([
			"earlier question",
			"previous answer",
			"tell me three things",
			`${S1} ${HEARD_ONLY_MARK}`,
		]);
	});

	test("chat() throws, the spoken error is interrupted: previous reply unchanged", async () => {
		const agent = makeAgent(PREVIOUS);
		const tracker = new VoiceReplyTracker();
		const amended: boolean[] = [];
		const run = await runTurn(["interrupt"], true, REPLY, {
			onMessage: voiceTurn(agent, tracker, async () => {
				throw new Error("provider down");
			}),
			onHeard: (h) => amended.push(tracker.amend(agent, h)),
		});
		expect(run.said).toEqual(["Error: provider down"]);
		expect(run.heard).toEqual([HEARD_ONLY_MARK]);
		expect(amended).toEqual([false]);
		expect(contents(agent)).toEqual(["earlier question", "previous answer"]);
	});

	test("agent not ready: nothing is amended", async () => {
		const tracker = new VoiceReplyTracker();
		const run = await runTurn(["interrupt"], true, REPLY, {
			onMessage: voiceTurn(null, tracker, async () => REPLY),
			onHeard: (h) => expect(tracker.amend(null, h)).toBe(false),
		});
		expect(run.said).toEqual(["Agent not ready."]);
	});

	test("a typed turn finishes while the voice reply is speaking: its reply is left alone", async () => {
		const agent = makeAgent(PREVIOUS);
		const tracker = new VoiceReplyTracker();
		const amended: boolean[] = [];
		await runTurn(["finish", "interrupt"], true, REPLY, {
			onMessage: voiceTurn(agent, tracker, async (t) => {
				pushTurn(agent, t, REPLY);
				return REPLY;
			}),
			onHeard: (h) => {
				pushTurn(agent, "typed question", "typed answer");
				amended.push(tracker.amend(agent, h));
			},
		});
		expect(amended).toEqual([false]);
		expect(contents(agent).slice(-2)).toEqual(["typed question", "typed answer"]);
		expect(contents(agent)).toContain(REPLY);
	});

	test("chat() returns without adding a reply: the previous reply is not touched", async () => {
		const agent = makeAgent(PREVIOUS);
		const tracker = new VoiceReplyTracker();
		const amended: boolean[] = [];
		await runTurn(["interrupt"], true, REPLY, {
			onMessage: voiceTurn(agent, tracker, async () => REPLY),
			onHeard: (h) => amended.push(tracker.amend(agent, h)),
		});
		expect(amended).toEqual([false]);
		expect(contents(agent)).toEqual(["earlier question", "previous answer"]);
	});

	test("a typed reply lands between chat returning and commit: the typed reply is intact", async () => {
		const agent = makeAgent(PREVIOUS);
		const tracker = new VoiceReplyTracker();
		const amended: boolean[] = [];
		await runTurn(["finish", "interrupt"], true, REPLY, {
			onMessage: voiceTurn(
				agent,
				tracker,
				async (t) => {
					pushTurn(agent, t, REPLY);
					return REPLY;
				},
				{ beforeCommit: () => pushTurn(agent, "typed question", "typed answer") },
			),
			onHeard: (h) => amended.push(tracker.amend(agent, h)),
		});
		expect(amended).toEqual([false]);
		expect(contents(agent).slice(-2)).toEqual(["typed question", "typed answer"]);
		expect(contents(agent)).toContain(REPLY);
	});

	test("an empty reply is never recorded", () => {
		const agent = makeAgent(PREVIOUS);
		const tracker = new VoiceReplyTracker();
		tracker.begin(agent);
		pushTurn(agent, "q", "");
		tracker.commit(agent, "");
		expect(tracker.amend(agent, HEARD_ONLY_MARK)).toBe(false);
		expect(contents(agent).at(-1)).toBe("");
	});

	test("the critic's second pass throws: no amend", async () => {
		const agent = makeAgent(PREVIOUS);
		const tracker = new VoiceReplyTracker();
		const amended: boolean[] = [];
		let calls = 0;
		const run = await runTurn(["interrupt"], true, REPLY, {
			onMessage: voiceTurn(
				agent,
				tracker,
				async (t) => {
					calls++;
					if (calls === 2) throw new Error("retry failed");
					pushTurn(agent, t, REPLY);
					return REPLY;
				},
				{ approve: async () => false },
			),
			onHeard: (h) => amended.push(tracker.amend(agent, h)),
		});
		expect(calls).toBe(2);
		expect(run.said).toEqual(["Error: retry failed"]);
		expect(amended).toEqual([false]);
		expect(contents(agent)).toEqual([
			"earlier question",
			"previous answer",
			"tell me three things",
			REPLY,
		]);
	});

	test("the critic rejects and the second pass succeeds: the second reply is trimmed", async () => {
		const agent = makeAgent(PREVIOUS);
		const tracker = new VoiceReplyTracker();
		const amended: boolean[] = [];
		let calls = 0;
		await runTurn(["finish", "interrupt"], true, REPLY, {
			onMessage: voiceTurn(
				agent,
				tracker,
				async (t) => {
					calls++;
					const reply = calls === 1 ? "first draft" : REPLY;
					pushTurn(agent, t, reply);
					return reply;
				},
				{ approve: async () => false },
			),
			onHeard: (h) => amended.push(tracker.amend(agent, h)),
		});
		expect(amended).toEqual([true]);
		expect(contents(agent).at(-1)).toBe(`${S1} ${HEARD_ONLY_MARK}`);
	});

	test("history shrank inside chat() (compaction): no amend", async () => {
		const agent = makeAgent([...PREVIOUS, ...PREVIOUS, ...PREVIOUS]);
		const tracker = new VoiceReplyTracker();
		const amended: boolean[] = [];
		await runTurn(["interrupt"], true, REPLY, {
			onMessage: voiceTurn(agent, tracker, async () => {
				agent.restoreFromCheckpoint([{ role: "assistant", content: "summary" }]);
				return REPLY;
			}),
			onHeard: (h) => amended.push(tracker.amend(agent, h)),
		});
		expect(amended).toEqual([false]);
		expect(contents(agent)).toEqual(["summary"]);
	});
});

describe("Agent.amendLastAssistantMessage", () => {
	test("replaces only the newest assistant message", () => {
		const agent = new Agent({ model: "eight-1.0-q3:14b", runtime: "ollama" });
		agent.restoreFromCheckpoint([
			{ role: "user", content: "first" },
			{ role: "assistant", content: "old reply" },
			{ role: "user", content: "tell me three things" },
			{ role: "assistant", content: REPLY },
		]);
		const heard = heardOnlyText(CHUNKS, 1) as string;
		expect(agent.amendLastAssistantMessage(heard, REPLY)).toBe(true);
		const history = agent.getMessageHistory().filter((m) => m.role !== "system");
		expect(history.map((m) => m.content)).toEqual([
			"first",
			"old reply",
			"tell me three things",
			heard,
		]);
	});

	test("returns false when there is no assistant message", () => {
		const agent = new Agent({ model: "eight-1.0-q3:14b", runtime: "ollama" });
		agent.restoreFromCheckpoint([{ role: "user", content: "hi" }]);
		expect(agent.amendLastAssistantMessage("x", "y")).toBe(false);
	});

	test("newest assistant message does not match the spoken reply: no amend", () => {
		const agent = makeAgent([
			...PREVIOUS,
			{ role: "user", content: "q" },
			{ role: "assistant", content: "other" },
		]);
		const heard = heardOnlyText(CHUNKS, 1) as string;
		expect(agent.amendLastAssistantMessage(heard, REPLY)).toBe(false);
		expect(contents(agent)).toEqual(["earlier question", "previous answer", "q", "other"]);
	});
});
