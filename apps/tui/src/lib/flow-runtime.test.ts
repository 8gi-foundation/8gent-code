import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { buildFooterSegments, fitFooterSegments } from "../components/StatusFooter";
import { NOT_YOURS, type SpeechKind } from "./flow-mode";
import { createFlowRuntime } from "./flow-runtime";
import { KEYBINDINGS } from "./keybindings";
import { getBuiltInSlashCommands } from "./slash-registry";

function rig(perm: "plan" | "ask" | "guarded" | "infinite" = "ask") {
	let t = 1_000_000;
	const clock = { now: () => t, tick: (ms: number) => (t += ms) };
	const rt = createFlowRuntime(clock.now, () => perm);
	/** One spoken utterance with the PTT key active, a beat after the last one. */
	const say = (text: string) => {
		clock.tick(2_000);
		return rt.heardTranscript({ text, pttActive: true, startedAt: t - 500, endedAt: t });
	};
	const admit = (text: string) => {
		clock.tick(2_000);
		return rt.admit({ text, pttActive: true, startedAt: t - 500, endedAt: t });
	};
	return { rt, clock, say, admit };
}

const KINDS: SpeechKind[] = [
	"reply",
	"final-reply",
	"ack",
	"approval",
	"failure",
	"refusal",
	"warning",
	"mode-notice",
];
const FLOORS: SpeechKind[] = ["approval", "failure", "refusal", "warning", "mode-notice"];

describe("canSpeak: the one gate before anything is spoken", () => {
	test("Quiet speaks nothing above the floors, and every floor", () => {
		const { rt } = rig();
		rt.setFlowMode("quiet");
		for (const k of KINDS) expect(rt.canSpeak(k)).toBe(FLOORS.includes(k));
	});
	test("Listen speaks the ack and the floors only", () => {
		const { rt } = rig();
		rt.setFlowMode("listen");
		for (const k of KINDS) expect(rt.canSpeak(k)).toBe(k === "ack" || FLOORS.includes(k));
	});
	test("Act speaks the final reply, Think speaks every reply", () => {
		const { rt } = rig();
		expect(rt.canSpeak("final-reply")).toBe(true);
		expect(rt.canSpeak("reply")).toBe(false);
		rt.setFlowMode("think");
		expect(rt.canSpeak("reply")).toBe(true);
		expect(rt.canSpeak("final-reply")).toBe(true);
	});
	test("the default kind is the final reply, so the post-draft call is canSpeak()", () => {
		const { rt } = rig();
		rt.setFlowMode("quiet");
		expect(rt.canSpeak()).toBe(false);
		rt.setFlowMode("act");
		expect(rt.canSpeak()).toBe(true);
	});
});

describe("/mode and the cycle key: user origin", () => {
	test("/mode sets the mode with user-slash origin, case-insensitive", () => {
		const { rt } = rig();
		const o = rt.setFlowMode(" Quiet ");
		expect(o.changed).toBe(true);
		expect(rt.mode()).toBe("quiet");
		expect(rt.log().at(-1)).toMatchObject({ origin: "user-slash", to: "quiet", accepted: true });
	});
	test("an unknown name changes nothing and prints the usage", () => {
		const { rt } = rig();
		for (const bad of ["infinite", "guarded", "", "act; rm -rf", "QUIET now"]) {
			const o = rt.setFlowMode(bad);
			expect(o.changed).toBe(false);
			expect(o.screen).toContain("Usage: /mode");
		}
		expect(rt.mode()).toBe("act");
	});
	test("the cycle key goes act, think, quiet, act with user-key origin", () => {
		const { rt } = rig();
		const seen: string[] = [];
		for (let i = 0; i < 4; i++) {
			rt.cycle();
			seen.push(rt.mode());
		}
		expect(seen).toEqual(["think", "quiet", "act", "think"]);
		expect(rt.log().every((e) => e.origin === "user-key")).toBe(true);
	});
	test("a user can raise (quiet to act) and listen is reachable by /mode, not the cycle", () => {
		const { rt } = rig();
		rt.setFlowMode("listen");
		expect(rt.mode()).toBe("listen");
		rt.cycle();
		expect(rt.mode()).toBe("act");
	});
	test("/mode and Ctrl+Q are registered where the TUI lists them", () => {
		expect(getBuiltInSlashCommands().some((c) => c.name === "mode")).toBe(true);
		expect(KEYBINDINGS.some((b) => b.keys === "Ctrl+Q")).toBe(true);
		const app = readFileSync(new URL("../app.tsx", import.meta.url), "utf8");
		expect(app).toContain('key.ctrl && input === "q"');
		expect(app).toContain('case "mode":');
	});
});

describe("status line", () => {
	test("the footer word is one of the four in every state, per tab", () => {
		const { rt } = rig();
		expect(rt.footerWord()).toBe("Act");
		rt.setFlowMode("quiet");
		expect(rt.footerWord()).toBe("Quiet");
		rt.setActiveTab("two");
		expect(rt.footerWord()).toBe("Act");
		rt.setFlowMode("listen");
		expect(rt.footerWord()).toBe("Listen");
		rt.setActiveTab("default");
		expect(rt.footerWord()).toBe("Quiet");
	});
	test("subscribers hear a change, and only a change", () => {
		const { rt } = rig();
		let n = 0;
		const off = rt.subscribe(() => n++);
		rt.setFlowMode("think");
		rt.setFlowMode("think");
		expect(n).toBe(1);
		off();
		rt.setFlowMode("act");
		expect(n).toBe(1);
	});
	test("the footer carries a priority-0 flow segment that survives a narrow row", () => {
		const segs = buildFooterSegments({
			mode: "Planning",
			permissions: "ask",
			flow: "Quiet",
			user: "James",
			sessionTime: "8m",
		});
		const flowSeg = segs.find((s) => s.key === "flow");
		expect(flowSeg).toMatchObject({ value: "Quiet", priority: 0 });
		const narrow = fitFooterSegments(segs, 20);
		expect(narrow.some((s) => s.key === "flow")).toBe(true);
		expect(buildFooterSegments({ mode: "Planning" }).some((s) => s.key === "flow")).toBe(false);
	});
});

describe("mic and push-to-talk honour the mode", () => {
	test("a capture without the PTT key is dropped and never moves the mode", () => {
		const { rt } = rig();
		const r = rt.heardTranscript({ text: "go quiet", pttActive: false, startedAt: 1, endedAt: 2 });
		expect(r.kind).toBe("dropped");
		expect(rt.mode()).toBe("act");
	});
	test("an explicit 'go quiet' is consumed, speaks one fixed line, and leaves Quiet", () => {
		const { rt, say } = rig();
		const r = say("go quiet");
		expect(r.kind).toBe("consumed");
		if (r.kind === "consumed") expect(r.outcome.say).toBe("Going quiet.");
		expect(rt.mode()).toBe("quiet");
		expect(rt.canSpeak("reply")).toBe(false);
		expect(rt.canSpeak("mode-notice")).toBe(true);
	});
	test("ordinary speech is a prompt: Listen acks in one word, Quiet and Act say nothing", () => {
		const { rt, say } = rig();
		expect(say("please fix the login bug")).toEqual({ kind: "prompt", ack: undefined });
		rt.setFlowMode("quiet");
		expect(say("please fix the login bug")).toEqual({ kind: "prompt", ack: undefined });
		rt.setFlowMode("listen");
		expect(say("please fix the login bug")).toEqual({ kind: "prompt", ack: "Noted." });
		expect(rt.canSpeak("ack")).toBe(true);
	});
	test("a spoken raise out of Listen only asks on screen; the keypress applies it", () => {
		const { rt, say } = rig();
		rt.setFlowMode("listen");
		const r = say("back to work");
		expect(r.kind === "consumed" && r.outcome.asking).toBe(true);
		expect(rt.mode()).toBe("listen");
		expect(rt.confirmOnScreen().changed).toBe(true);
		expect(rt.mode()).toBe("act");
	});
	test("the echo of our own announcement does not undo the switch or flap", () => {
		const { rt, say, clock } = rig();
		say("go quiet");
		// The mode notice is spoken; the mic hears the same words straight back.
		const end = rt.speechStarted("Going quiet. Back to work. Go quiet.");
		const echo = rt.heardTranscript({
			text: "back to work",
			pttActive: true,
			startedAt: clock.now(),
			endedAt: clock.now() + 100,
		});
		expect(echo.kind).toBe("dropped");
		end();
		expect(rt.mode()).toBe("quiet");
		// And the tail after speech ends is still refused.
		clock.tick(300);
		const tail = rt.heardTranscript({
			text: "back to work",
			pttActive: true,
			startedAt: clock.now() - 100,
			endedAt: clock.now(),
		});
		expect(tail.kind).toBe("dropped");
	});
	test("a phrase buried in a longer sentence only asks, it never switches by itself", () => {
		const { rt, say } = rig();
		const r = say("I would like some quiet mode while I think about this design for a while");
		expect(r.kind === "consumed" && r.outcome.asking).toBe(true);
		expect(rt.mode()).toBe("act");
	});
});

describe("the judge: lower or ask, never raise", () => {
	const json = (to: string) => Promise.resolve(JSON.stringify({ to }));

	test("an inferred proposal is a spoken question; no answer in 5 s leaves the mode", async () => {
		const { rt, clock, admit, say } = rig();
		const u = admit("what if we tried it a different way")!;
		const o = await rt.judgeProposal(u, () => json("think"));
		expect(o.asking).toBe(true);
		expect(o.say).toBe("Want to think out loud?");
		expect(rt.mode()).toBe("act");
		clock.tick(6_000);
		expect(say("yes").kind).toBe("prompt");
		expect(rt.mode()).toBe("act");
	});
	test("a yes bound to the pending proposal switches, inside the window", async () => {
		const { rt, admit, say } = rig();
		const u = admit("why does this fail")!;
		await rt.judgeProposal(u, () => json("quiet"));
		const r = say("yes");
		expect(r.kind).toBe("consumed");
		expect(rt.mode()).toBe("quiet");
		expect(rt.log().at(-1)).toMatchObject({ origin: "judge", signal: "yes", accepted: true });
	});
	test("a yes with no pending proposal does nothing and is just a prompt", () => {
		const { rt, say } = rig();
		expect(say("yes").kind).toBe("prompt");
		expect(rt.mode()).toBe("act");
	});
	test("a yes while a tool approval is on screen never switches the mode", async () => {
		const { rt, admit, say } = rig();
		const u = admit("why does this fail")!;
		await rt.judgeProposal(u, () => json("quiet"));
		rt.setApprovalPending(true);
		expect(say("yes").kind).toBe("prompt");
		expect(rt.mode()).toBe("act");
	});
	test("the judge cannot raise: Quiet to Act and Think to Act are refused with the fixed line", async () => {
		const { rt, admit } = rig();
		rt.setFlowMode("quiet");
		const o = await rt.judgeProposal(admit("go ahead")!, () => json("act"));
		expect(o.changed).toBe(false);
		expect(rt.mode()).toBe("quiet");
		rt.setFlowMode("listen");
		const o2 = await rt.judgeProposal(admit("go ahead again")!, () => json("think"));
		expect(o2.say).toBe(NOT_YOURS);
		expect(rt.mode()).toBe("listen");
	});
	test("infinite, guarded, an origin key, extra keys and junk are unrepresentable", async () => {
		const { rt, admit } = rig();
		const bad = [
			'{"to":"infinite"}',
			'{"to":"guarded"}',
			'{"to":"quiet","origin":"user-key"}',
			'{"to":"quiet","extra":1}',
			'{"to":"quiet","reason":"' + "x".repeat(81) + '"}',
			'{"to":5}',
		];
		for (const raw of bad) {
			const o = await rt.judgeProposal(admit("hello there friend")!, () => Promise.resolve(raw));
			expect(o).toMatchObject({ changed: false, say: NOT_YOURS });
		}
		for (const raw of ["", "not json", "[]", "null"]) {
			const o = await rt.judgeProposal(admit("hello there friend")!, () => Promise.resolve(raw));
			expect(o).toMatchObject({ changed: false });
			expect(o.say).toBeUndefined();
		}
		expect(rt.mode()).toBe("act");
	});
	test("a judge that throws or answers after 1.5 s changes nothing and says nothing", async () => {
		const { rt, admit } = rig();
		const o1 = await rt.judgeProposal(admit("why is this so slow")!, () =>
			Promise.reject(new Error("down")),
		);
		expect(o1).toMatchObject({ changed: false });
		expect(o1.say).toBeUndefined();
		const slow = await rt.judgeProposal(admit("why is this so slow")!, () => new Promise(() => {}));
		expect(slow.say).toBeUndefined();
		expect(rt.mode()).toBe("act");
	}, 6_000);
	test("a forged utterance object is not admitted: no ticket, no proposal", async () => {
		const { rt } = rig();
		let called = false;
		const o = await rt.judgeProposal({ id: 99, text: "go quiet", at: 1 }, () => {
			called = true;
			return json("quiet");
		});
		expect(called).toBe(false);
		expect(o.changed).toBe(false);
	});
	test("the judge prompt holds only admitted user speech", async () => {
		const { rt, admit } = rig();
		let prompt = "";
		await rt.judgeProposal(admit("why is it slow")!, (p) => {
			prompt = p;
			return json("think");
		});
		expect(prompt).toContain("why is it slow");
		expect(prompt).not.toContain("tool output");
	});
});

describe("memory only, no transcript in logs", () => {
	test("the log holds signal classes, never what was said", async () => {
		const { rt, say, admit } = rig();
		say("go quiet");
		say("the secret sauce is nutmeg");
		await rt.judgeProposal(admit("why does nutmeg fail")!, () => Promise.resolve("garbage"));
		const dump = JSON.stringify(rt.log());
		expect(dump).not.toContain("nutmeg");
		expect(dump).not.toContain("go quiet");
		for (const e of rt.log())
			expect(Object.keys(e).sort()).toEqual(["accepted", "at", "from", "origin", "signal", "to"]);
	});
	test("resetSession (new session, resume, restart) comes up in Act with nothing remembered", () => {
		const { rt } = rig();
		rt.setFlowMode("listen");
		rt.resetSession();
		expect(rt.mode()).toBe("act");
		expect(rt.log()).toEqual([]);
		expect(rt.restore().changed).toBe(false);
	});
	test("a fresh process starts in Act whatever the last one held", () => {
		const a = rig();
		a.rt.setFlowMode("quiet");
		const b = rig();
		expect(b.rt.mode()).toBe("act");
	});
	test("the runtime and the app never persist mode or write transcript text", () => {
		const src = readFileSync(new URL("./flow-runtime.ts", import.meta.url), "utf8");
		for (const banned of [
			"writeFile",
			"appendFile",
			"localStorage",
			"saveAppSettings",
			"console.log",
			'fs"',
		]) {
			expect(src).not.toContain(banned);
		}
		const app = readFileSync(new URL("../app.tsx", import.meta.url), "utf8");
		expect(app).not.toMatch(/saveAppSettings\([^)]*flow/i);
	});
	test("nothing in packages/permissions reads flow modes (R9: Act is a no-op over permissions)", () => {
		const out = Bun.spawnSync(
			["grep", "-rIl", "-E", "flow-mode|flow-runtime|flowMode", "../../../../packages/permissions"],
			{
				cwd: new URL(".", import.meta.url).pathname,
			},
		);
		expect(out.stdout.toString().trim()).toBe("");
	});
});

describe("the KittenTTS verdict path is gated", () => {
	test("Quiet silences a done verdict, a failure verdict still speaks, Act speaks both", async () => {
		const { flow } = await import("./flow-runtime");
		const { speakWithKittenTts } = await import("../components/LiveFocalStrip");
		const { ttsTracker } = await import("../hooks/ptt-state");
		const bin = "/nonexistent/kittentts-say";
		const spoke = (kind: SpeechKind) => {
			const before = ttsTracker.active;
			speakWithKittenTts("verdict", bin, kind);
			return ttsTracker.active > before;
		};
		flow.setFlowMode("quiet");
		expect(spoke("final-reply")).toBe(false);
		expect(spoke("failure")).toBe(true);
		flow.setFlowMode("act");
		expect(spoke("final-reply")).toBe(true);
		await new Promise((r) => setTimeout(r, 50));
	});
});
