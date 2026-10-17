import { describe, expect, test } from "bun:test";
import {
	SPOKEN_DRAFT_INSTRUCTION,
	capAtSentence,
	createSpokenQueue,
	makeSpokenDraft,
	prepareForSpeech,
} from "./spoken-draft";

const EM = String.fromCharCode(0x2014);

describe("prepareForSpeech", () => {
	test("code fences become one cue, open fences too", () => {
		const t = prepareForSpeech("Done.\n```ts\nconst a = 1;\n```\nNext.");
		expect(t).toContain("There is a code block on screen.");
		expect(t).not.toContain("const");
		expect(prepareForSpeech("Try:\n```sh\nrm -rf x")).not.toContain("rm");
	});
	test("urls and markdown links never read aloud", () => {
		const t = prepareForSpeech(
			"See [the docs](https://example.com/a/b) or https://x.dev/y?z=1 now",
		);
		expect(t).toContain("the docs");
		expect(t).toContain("a link");
		expect(t).not.toContain("http");
		expect(t).not.toContain("example.com");
	});
	test("paths shrink to the file name, with line numbers dropped", () => {
		const t = prepareForSpeech("Edited /Users/jo/proj/src/app.tsx:42 and ./packages/voice/vad.ts");
		expect(t).toContain("the file app.tsx");
		expect(t).toContain("the file vad.ts");
		expect(t).not.toContain("/Users");
		expect(t).not.toContain(":42");
	});
	test("symbols and numbers are said as people say them", () => {
		const t = prepareForSpeech("Latency fell 40% (1,200 ms) a -> b, see #4350 w/ care & more");
		expect(t).toContain("40 percent");
		expect(t).toContain("1200 ms");
		expect(t).toContain("a to b");
		expect(t).toContain("number 4350");
		expect(t).toContain("with care and more");
	});
	test("markdown is stripped, em dashes become pauses, lines become sentences", () => {
		const t = prepareForSpeech(`## Result\n- **fast** and \`safe\`\n- done ${EM} ok`);
		expect(t).toBe("Result. fast and safe. done, ok.");
		expect(t.includes(EM)).toBe(false);
	});
	test("empty in, empty out", () => {
		expect(prepareForSpeech("")).toBe("");
		expect(prepareForSpeech("```\nonly code\n```")).toBe("There is a code block on screen.");
	});
});

describe("option injection", () => {
	test("a leading dash is never left in front of say", () => {
		expect(prepareForSpeech("-o x.aiff hello")).toBe("o x.aiff hello.");
		expect(prepareForSpeech("-f ~/secret")[0]).not.toBe("-");
		expect(prepareForSpeech("--voice=x go")[0]).not.toBe("-");
		expect(prepareForSpeech("  \n- - dash")[0]).not.toBe("-");
	});
	test("a model draft starting with a dash is neutralised too", async () => {
		const out = await makeSpokenDraft("hi there", async () => "-f /etc/passwd now");
		expect(out.startsWith("-")).toBe(false);
	});
	test("the say call ends options with --", () => {
		const src = require("node:fs").readFileSync(
			require("node:path").join(import.meta.dir, "../../apps/tui/src/app.tsx"),
			"utf8",
		);
		expect(src).toContain('["-v", voice, "--", draft]');
	});
});

describe("capAtSentence", () => {
	test("cuts at a sentence end", () => {
		const s = `${"Hello there. ".repeat(100)}`;
		const c = capAtSentence(s, 100);
		expect(c.length).toBeLessThanOrEqual(100);
		expect(c.endsWith(".")).toBe(true);
	});
});

describe("makeSpokenDraft", () => {
	const reply = "## Fixed\nI changed `/a/b/c.ts`.\n```ts\nx()\n```\nSee https://x.dev/y";

	test("the model sees the prepared text under the fixed instruction, never raw code or urls", async () => {
		let seen = "";
		const out = await makeSpokenDraft(reply, async (p) => {
			seen = p;
			return "I fixed it. Nothing else to do.";
		});
		expect(seen.startsWith(SPOKEN_DRAFT_INSTRUCTION)).toBe(true);
		expect(seen).not.toContain("```");
		expect(seen).not.toContain("https://");
		expect(out).toBe("I fixed it. Nothing else to do.");
	});
	test("model output is cleaned again before speaking", async () => {
		const out = await makeSpokenDraft(reply, async () => `**Done** ${EM} see https://x.dev/y`);
		expect(out).toBe("Done, see a link.");
	});
	test("speech uses the draft while the on-screen reply is unchanged", async () => {
		const screen = reply;
		const spoken: string[] = [];
		const draft = await makeSpokenDraft(screen, async () => "Short and sweet.");
		spoken.push(draft);
		expect(spoken).toEqual(["Short and sweet."]);
		expect(screen).toBe(reply);
		expect(screen).toContain("```");
	});
	test("falls back to the deterministic text on error, empty or timeout", async () => {
		const fallback = prepareForSpeech(reply);
		expect(await makeSpokenDraft(reply, async () => Promise.reject(new Error("down")))).toBe(
			fallback,
		);
		expect(await makeSpokenDraft(reply, async () => "  ")).toBe(fallback);
		expect(await makeSpokenDraft(reply, () => new Promise(() => {}), 20)).toBe(fallback);
		expect(await makeSpokenDraft(reply, null)).toBe(fallback);
	});
	test("nothing to say, nothing spoken", async () => {
		expect(await makeSpokenDraft("   ", async () => "x")).toBe("");
	});
});

describe("spoken queue", () => {
	function deps() {
		const log: string[] = [];
		let active = 0;
		return {
			log,
			active: () => active,
			d: {
				start: () => {
					active++;
					log.push("start");
				},
				end: () => {
					active--;
					log.push("end");
				},
			},
		};
	}
	test("speech is pending during the rewrite and cleared after play", async () => {
		const x = deps();
		const q = createSpokenQueue(x.d);
		let release: (v: string) => void = () => {};
		const p = q.enqueue(
			"hello there",
			() => new Promise<string>((r) => (release = r)),
			(d) => x.log.push(`play:${d}`),
		);
		expect(x.active()).toBe(1);
		await new Promise((r) => setTimeout(r, 5));
		expect(x.active()).toBe(1);
		release("Hi.");
		await p;
		expect(x.active()).toBe(0);
		expect(x.log).toEqual(["start", "play:Hi.", "end"]);
	});
	test("pending is cleared when the draft is empty or play throws", async () => {
		const x = deps();
		const q = createSpokenQueue(x.d);
		await q.enqueue(
			"   ",
			async () => "x",
			() => x.log.push("play"),
		);
		await q.enqueue(
			"hi",
			async () => "ok.",
			() => {
				throw new Error("spawn failed");
			},
		);
		expect(x.active()).toBe(0);
		expect(x.log).not.toContain("play");
	});
	test("two close replies are spoken in order, never overlapping", async () => {
		const x = deps();
		const q = createSpokenQueue(x.d);
		const order: string[] = [];
		const slow = q.enqueue(
			"one",
			() => new Promise<string>((r) => setTimeout(() => r("First."), 30)),
			(d) => order.push(d),
		);
		const fast = q.enqueue(
			"two",
			async () => "Second.",
			(d) => order.push(d),
		);
		expect(x.active()).toBe(2);
		await Promise.all([slow, fast]);
		expect(order).toEqual(["First.", "Second."]);
		expect(x.active()).toBe(0);
	});
	test("a timed-out model call is aborted", async () => {
		let aborted = false;
		await makeSpokenDraft(
			"hi",
			(_p, signal) =>
				new Promise<string>(() => {
					signal?.addEventListener("abort", () => {
						aborted = true;
					});
				}),
			20,
		);
		expect(aborted).toBe(true);
	});
});
