/**
 * Task artifacts, and not doing the same job twice.
 *
 * James asked Rishi for a diagram of an agent vessel. The task ran on his codex
 * harness and SUCCEEDED. He got 1004 characters of raw mermaid source truncated
 * mid-token at "Agent --> Ar" in a chat bubble, asked "where is it?", got no
 * reply, said "i dont see the diagram yet", and received the identical answer
 * plus a duplicate task under a new token.
 *
 * Nothing here was a capability problem. The deliverable was being returned as
 * a chat message, and nothing remembered that the work had just run.
 */

import { afterAll, describe, expect, it } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import {
	artifactDirFor,
	artifactInstruction,
	collectArtifacts,
	humanBytes,
	prepareArtifactDir,
	writeFullLog,
} from "../artifacts";
import { findRecentCompletion, noteCompleted, stagePending } from "../helm-bridge";

const TOKENS = ["TESTART1", "TESTART2", "TESTART3"];
afterAll(() => {
	for (const t of TOKENS) fs.rmSync(artifactDirFor(t), { recursive: true, force: true });
});

describe("artifact directory", () => {
	it("is namespaced by token and never escapes the tasks root", () => {
		// The token reaches a filesystem path, so it is sanitised rather than
		// trusted, even though stagePending only ever generates [A-Z0-9].
		const nasty = artifactDirFor("../../../etc/passwd");
		expect(nasty).toContain("creative");
		expect(nasty).not.toContain("..");
		expect(path.isAbsolute(nasty)).toBe(true);
	});

	it("tells the worker where to write, in words", () => {
		// helm builds a fixed minimal env with no per-spawn passthrough, and an
		// env var an LLM never reads would do nothing anyway - the instruction
		// has to be in the prompt.
		const dir = artifactDirFor("TESTART1");
		const text = artifactInstruction(dir);
		expect(text).toContain(dir);
		expect(text.toLowerCase()).toContain("mermaid");
	});
});

describe("collecting what a task produced", () => {
	it("returns nothing when the task wrote nothing, rather than inventing a row", () => {
		prepareArtifactDir("TESTART2");
		expect(collectArtifacts("TESTART2")).toEqual([]);
	});

	// Rendering shells out to headless Chrome. Run alongside the huddle suite -
	// which drives Chrome for the bake - the two contend and this times out. A
	// test that flakes under parallel load teaches people to ignore failures, so
	// the Chrome-dependent assertion is opt-in (RENDER_LIVE=1), exactly as the
	// LM Studio client test gates its live smoke. The DETERMINISTIC half of the
	// behaviour is tested unconditionally below, without Chrome.
	it.skipIf(process.env.RENDER_LIVE !== "1")(
		"renders source to a PNG and puts the render first (RENDER_LIVE=1)",
		() => {
		const dir = prepareArtifactDir("TESTART1");
		fs.writeFileSync(
			path.join(dir, "vessel.svg"),
			'<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200">' +
				'<rect width="400" height="200" fill="#100c0b"/>' +
				'<text x="30" y="100" fill="#F07A28" font-size="28">Vessel</text></svg>',
		);
		fs.writeFileSync(path.join(dir, "notes.md"), "# notes\n");

		const arts = collectArtifacts("TESTART1");
		const names = arts.map((a) => a.name);
		expect(names).toContain("vessel.svg"); // source stays editable and diffable
		expect(names).toContain("notes.md"); // a non-renderable file still lands

		const png = arts.find((a) => a.name === "vessel.png");
		if (png) {
			// Chrome is present: the render must lead, and know its source.
			expect(png.rendered).toBe(true);
			expect(png.from).toBe("vessel.svg");
			expect(arts[0].name).toBe("vessel.png");
			expect(png.bytes).toBeGreaterThan(1000);
		}
		// If Chrome is absent the source still ships and nothing false is claimed -
		// which is the whole point of keeping both.
		},
	);

	it("keeps every file the task wrote, whether or not it can be rendered", () => {
		// The half that must NEVER depend on an external binary: a source file and
		// a plain file both survive collection. This is what actually protects the
		// deliverable - rendering is a bonus on top.
		const dir = prepareArtifactDir("TESTART2");
		fs.writeFileSync(path.join(dir, "diagram.mmd"), "graph TD\n  A --> B");
		fs.writeFileSync(path.join(dir, "readme.txt"), "hello");
		const names = collectArtifacts("TESTART2").map((a) => a.name);
		expect(names).toContain("diagram.mmd");
		expect(names).toContain("readme.txt");
	});

	it("never treats its own bookkeeping as a deliverable", () => {
		writeFullLog("TESTART3", "x".repeat(500));
		expect(collectArtifacts("TESTART3").map((a) => a.name)).not.toContain("output.log");
	});

	it("writes the FULL log, so a truncated chat tail is never lossy", () => {
		const big = "line\n".repeat(5000);
		const p = writeFullLog("TESTART3", big);
		expect(p).toBeTruthy();
		expect(fs.readFileSync(p as string, "utf8").length).toBe(big.length);
	});
});

describe("humanBytes", () => {
	it("reads as a size, because 151552 does not", () => {
		expect(humanBytes(900)).toBe("900 B");
		expect(humanBytes(151552)).toBe("148 KB");
		expect(humanBytes(5 * 1024 * 1024)).toBe("5.0 MB");
	});
});

describe("not doing the same job twice", () => {
	const command = "create mermaid diagram for an 8gent agent vessel";

	it("finds nothing before the work has run", () => {
		expect(findRecentCompletion("chanRepeat", "agent:8TO", command)).toBeNull();
	});

	it("matches the same work again, ignoring case and spacing", () => {
		const p = stagePending(
			{ kind: "shell", cwd: `${process.env.HOME}/8gent-code`, command, isTask: true },
			"chanRepeat",
			"agent:8TO",
		);
		noteCompleted(p, "/tmp/x", ["vessel.png", "vessel.mmd"]);
		// A human retyping the request will not reproduce the exact string.
		const hit = findRecentCompletion("chanRepeat", "agent:8TO", "Create Mermaid  Diagram For An 8gent Agent Vessel");
		expect(hit).not.toBeNull();
		expect(hit?.artifactNames).toContain("vessel.png");
	});

	it("does not leak across channels or officers", () => {
		// The same question in another room, or to another officer, is a real
		// request and must still run.
		expect(findRecentCompletion("otherChannel", "agent:8TO", command)).toBeNull();
		expect(findRecentCompletion("chanRepeat", "agent:8PO", command)).toBeNull();
	});

	it("does not match different work in the same room", () => {
		expect(findRecentCompletion("chanRepeat", "agent:8TO", "something else entirely")).toBeNull();
	});
});
