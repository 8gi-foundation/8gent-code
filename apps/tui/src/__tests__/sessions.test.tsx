/**
 * Sessions in the real App (#3918 E1, E3, E4, E7): the tree store is the
 * session of record; /export and /import move its file; /tree, /branch and
 * /fork work on it; /resume is the searchable picker. The frames are written
 * as an asciicast under $TMPDIR.
 */
import { expect, test } from "bun:test";
import * as path from "node:path";
import { runAppHarness } from "./app-driver.js";
import { type Frame, castPath, writeCast } from "./cast.js";
import { serveFakeModel } from "./fake-model.js";

const REPLY = "SESSION_REPLY_ONE";

test("/export, /branch, /tree, /fork, /resume and /import work on the tree store", async () => {
	const model = serveFakeModel(REPLY);
	try {
		const events = await runAppHarness(
			path.join(import.meta.dir, "sessions.harness.tsx"),
			{ ...model.env, FAKE_REPLY: REPLY },
			120_000,
		);
		const frames = (events.find((e) => e.phase === "frames")?.frames ?? []) as Frame[];
		const cast = castPath("pi-tui-e1-e3-e4-e7-sessions");
		writeCast(cast, frames, 160, 60, "8gent Code: /export, /tree, /fork, /resume picker, /import");
		console.log(`[sessions.test] ${frames.length} frames -> ${cast}`);

		expect(events.find((e) => e.phase === "error")).toBeUndefined();

		// E7: the export is the session file: the header and the three chat
		// messages (the welcome, the question, the reply).
		const exported = events.find((e) => e.phase === "export");
		expect(exported?.hasUser).toBeTrue();
		expect(exported?.hasReply).toBeTrue();
		expect(exported?.roles).toEqual(["assistant", "user", "assistant"]);
		expect(Number(exported?.lines)).toBeGreaterThanOrEqual(4);

		// E4: one branch so far; the tree shows both messages; continuing from
		// the user message drops the reply from the transcript.
		expect(String(events.find((e) => e.phase === "branch")?.screen)).toMatch(/\* - 3 msgs/);
		const tree = String(events.find((e) => e.phase === "tree")?.screen);
		expect(tree).toContain("hello one");
		expect(tree).toContain(REPLY);
		const cont = events.find((e) => e.phase === "tree-continue");
		expect(cont?.line).toContain("(2 messages on this path)");
		expect(cont?.replyStillShown).toBeFalse();

		// /fork names the new session and says the original is unchanged.
		expect(String(events.find((e) => e.phase === "fork")?.line)).toContain('"forked-copy"');

		// E3: the picker lists the fork; the search narrows to it; Enter resumes it.
		expect(String(events.find((e) => e.phase === "picker")?.screen)).toContain("forked-copy");
		const filtered = String(events.find((e) => e.phase === "picker-filtered")?.screen);
		expect(filtered).toContain("forked-copy");
		expect(filtered).toContain("» forked");
		expect(String(events.find((e) => e.phase === "resumed")?.line)).toContain("2 messages");

		// E7: the import is a new session that opens at once.
		expect(String(events.find((e) => e.phase === "import")?.line)).toMatch(
			/as session \S+ \(3 messages\)/,
		);
		const three = String(events.find((e) => e.phase === "picker-three")?.screen);
		// Picker rows read "<n> msgs    <age>"; chat bubbles do not.
		expect((three.match(/\d+ msgs\s+\d+[smhd]/g) ?? []).length).toBe(3);
	} finally {
		model.stop();
	}
}, 150_000);
