/**
 * The stage page's SUBSCRIPTION contract.
 *
 * The stage renders `huddle:slide` / `huddle:speak`, and the daemon fans both of
 * those out with broadcastToChannel(), which reaches only connections sitting in
 * `subscribedChannels`. The single frame that enrols a connection there is
 * `message:subscribe` (packages/daemon/table-routes.ts). `huddle:subscribe`
 * answers with a snapshot and enrols nobody.
 *
 * So a stage page that opens its socket and sends only `huddle:subscribe` shows
 * its idle card for the entire huddle. That was measured against the live daemon,
 * not inferred: a second connection that sent only `huddle:subscribe` received
 * `huddle:state` and then nothing at all while a three-turn huddle ran to
 * completion beside it.
 *
 * These tests pin the fix so the page can never silently lose its frames again.
 */

import { describe, expect, test } from "bun:test";
import { stagePage } from "../stage";

const OPTS = { huddleId: "huddle_abc123", wsUrl: "ws://127.0.0.1:18789", topic: "Ship the pane" };

describe("stagePage subscription", () => {
	test("subscribes to the huddle's channel when one is supplied", () => {
		const html = stagePage({ ...OPTS, channelId: "chan_deadbeef" });
		expect(html).toContain("chan_deadbeef");
		expect(html).toContain('type:"message:subscribe"');
		// Both frames, not one instead of the other: the snapshot answers "who holds
		// the floor right now" on a mid-huddle reconnect, the subscription delivers
		// everything after that.
		expect(html).toContain('type:"huddle:subscribe"');
	});

	test("omits the subscribe entirely when there is no channel (the replay harness)", () => {
		const html = stagePage(OPTS);
		expect(html).toContain('"channelId":""');
		// The frame is still compiled into the page, but guarded by `if (CFG.channelId)`,
		// so a replay socket that knows nothing about channels is never sent one.
		expect(html).toContain("if (CFG.channelId)");
	});

	test("seeds no message backlog - a stage renders slides, not a thread", () => {
		const html = stagePage({ ...OPTS, channelId: "chan_deadbeef" });
		expect(html).toContain("seed: 0");
	});

	test("letterboxes the fixed 1920x1080 slide into whatever viewport it has", () => {
		// slide-render.ts authors every slide at exactly 1920x1080 with
		// overflow:hidden, because the bake screenshots it at that size. Without a
		// fit the stage showed the top-left crop of that canvas - and since a slide
		// pads 112px/128px, that crop is empty background. It rendered as a black
		// rectangle anywhere that was not full HD, including the Mac app's pane.
		const html = stagePage({ ...OPTS, channelId: "chan_x" });
		expect(html).toContain("SLIDE_W = 1920");
		expect(html).toContain("SLIDE_H = 1080");
		expect(html).toContain("Math.min(vw / SLIDE_W, vh / SLIDE_H)");
		expect(html).toContain("transform-origin:top left");
		// And it stays correct when the window changes size.
		expect(html).toContain('addEventListener("resize", fitAll)');
	});

	test("keeps the enter/park animation off the element that carries the fit", () => {
		// Both effects are transforms and one property cannot hold both, so the slot
		// animates and the frame scales. If these ever merge, the slide either stops
		// fitting or stops transitioning.
		const html = stagePage({ ...OPTS, channelId: "chan_x" });
		expect(html).toContain(".slot.parked");
		expect(html).toContain('slot.className = "slot"');
		expect(html).toContain("slot.appendChild(frame)");
	});

	test("never yields the floor when narration ends", () => {
		// huddle:yield is human-only and only valid for the holder of the turn. A
		// viewer watching an OFFICER speak holds nothing, so yielding on audio end
		// made the FloorMachine broadcast HUDDLE_FORBIDDEN to the whole channel
		// after every turn - surfacing to the person watching as
		// "cannot yield a turn you do not hold", for something they had not done.
		// The daemon's own speak timer releases an agent turn.
		const html = stagePage({ ...OPTS, channelId: "chan_x" });
		// The frame construction, not the word - the comment explaining why names it.
		expect(html).not.toContain('type:"huddle:yield"');
		expect(html).not.toContain("audio.onended");
	});

	test("re-fits after layout settles, for a host that sizes its view late", () => {
		const html = stagePage({ ...OPTS, channelId: "chan_x" });
		expect(html).toContain("fitAll();");
	});

	test("the slide iframe stays fully sandboxed", () => {
		// The stage's own script context must never be shared with slide content.
		const html = stagePage({ ...OPTS, channelId: "chan_x" });
		expect(html).toContain('frame.setAttribute("sandbox", "")');
	});

	test("is pure: same options in, byte-identical page out", () => {
		const a = stagePage({ ...OPTS, channelId: "chan_deadbeef" });
		const b = stagePage({ ...OPTS, channelId: "chan_deadbeef" });
		expect(a).toBe(b);
	});

	test("still escapes the topic it is given", () => {
		const html = stagePage({ ...OPTS, topic: '<script>alert(1)</script>', channelId: "chan_x" });
		expect(html).not.toContain("<script>alert(1)</script>");
		expect(html).toContain("&lt;script&gt;");
	});
});
