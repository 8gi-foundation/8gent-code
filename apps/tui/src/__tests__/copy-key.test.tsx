/** Ctrl+U copies the last message with OSC 52, in the real App (#181). */
import { expect, test } from "bun:test";
import * as path from "node:path";
import { osc52 } from "../lib/mouse-wiring.js";
import { runAppHarness } from "./app-driver.js";
import { serveFakeModel } from "./fake-model.js";

const run = async (reply: string, first: string) => {
	const model = serveFakeModel(reply);
	try {
		return await runAppHarness(path.join(import.meta.dir, "copy-key.harness.tsx"), {
			...model.env,
			FAKE_REPLY: reply,
			FAKE_FIRST: first,
			// Local copy commands stay out of the test; OSC 52 is the path under test.
			SSH_CONNECTION: "test",
			TMUX: "",
			STY: "",
		});
	} finally {
		model.stop();
	}
};

test("Ctrl+U sends the last message as base64 OSC 52 and says how many lines", async () => {
	const reply = "Copy me: ünïcode and all";
	const events = await run(reply, reply);
	expect(events.find((e) => e.phase === "error")).toBeUndefined();
	expect(events.find((e) => e.phase === "empty")?.ok).toBeTrue();
	const copied = events.find((e) => e.phase === "copied");
	expect(copied?.line).toBe("Sent 1 line to the terminal clipboard");
	const raw = String(copied?.raw);
	expect(raw).toContain(osc52(reply));
	expect(osc52(reply)).toBe(`\x1b]52;c;${Buffer.from(reply, "utf8").toString("base64")}\x07`);
}, 90000);

test("a message over the terminal's size limit is not sent, and the footer says so", async () => {
	const reply = "x".repeat(80_000);
	const events = await run(reply, "xxxxxxxxxx");
	expect(events.find((e) => e.phase === "error")).toBeUndefined();
	const copied = events.find((e) => e.phase === "copied");
	expect(copied?.line).toBe("Not copied: 1 line is too long");
	expect(String(copied?.raw)).not.toContain("\x1b]52;");
}, 90000);
