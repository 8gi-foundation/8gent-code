/**
 * The rule that makes a deck trustworthy: NO NUMBER ON A SLIDE WAS EVER
 * AUTHORED BY A MODEL, and anything the system could not verify is visibly
 * marked rather than stated flatly.
 *
 * These run against a real temp git repo and real files, because the whole
 * point of the substrate is that references resolve against real state.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifySlideSpec } from "../slide-verify";
import { renderSlide } from "../slide-render";
import { voiceFor } from "../huddle-voice";
import type { SlideSpec } from "../slide-spec";

let repo: string;
let head: string;

beforeAll(() => {
	repo = mkdtempSync(join(tmpdir(), "huddle-verify-"));
	writeFileSync(join(repo, "a.txt"), "one\ntwo\nthree\n");
	const git = (...args: string[]) => spawnSync("git", args, { cwd: repo, encoding: "utf8" });
	git("init", "-q");
	git("config", "user.email", "t@t.t");
	git("config", "user.name", "t");
	git("add", "-A");
	git("commit", "-qm", "init");
	head = (git("rev-parse", "HEAD").stdout ?? "").trim();
});

afterAll(() => rmSync(repo, { recursive: true, force: true }));

const opts = () => ({ roots: [repo] });

describe("verifySlideSpec", () => {
	it("replaces a reference with the real resolved value", () => {
		const spec: SlideSpec = {
			layout: "metric",
			heading: "Lines",
			metric: { value: `[[CLAIM src=file.lines path=${join(repo, "a.txt")}]]`, label: "lines in a.txt" },
		};
		const out = verifySlideSpec(spec, opts());
		expect(out.spec.metric?.value).toBe("3");
		expect(out.assertedFields).toEqual([]);
	});

	it("resolves a git head to the real commit", () => {
		const spec: SlideSpec = {
			layout: "metric",
			heading: "Head",
			metric: { value: `[[CLAIM src=git.head repo=${repo}]]`, label: "head" },
		};
		const out = verifySlideSpec(spec, opts());
		// Clipped to the field's 12-char budget, but it is the REAL hash's prefix.
		expect(head).toStartWith(out.spec.metric?.value.replace(/…$/, "") ?? "@@");
		expect(out.assertedFields).toEqual([]);
	});

	it("marks a field ASSERTED when the officer's value disagrees with reality", () => {
		const spec: SlideSpec = {
			layout: "metric",
			heading: "Lines",
			metric: { value: `[[CLAIM src=file.lines path=${join(repo, "a.txt")} expect=999]]`, label: "lines" },
		};
		const out = verifySlideSpec(spec, opts());
		expect(out.assertedFields).toContain("metric.value");
		// The officer's own claim survives, clearly flagged - not silently swapped.
		expect(out.spec.metric?.value).toBe("999");
	});

	it("marks a field ASSERTED when the extractor is unknown", () => {
		const spec: SlideSpec = {
			layout: "metric",
			heading: "X",
			metric: { value: "[[CLAIM src=made.up expect=42]]", label: "x" },
		};
		expect(verifySlideSpec(spec, opts()).assertedFields).toContain("metric.value");
	});

	it("shows 'unknown' rather than a stripped-claim string when nothing was asserted", () => {
		const spec: SlideSpec = { layout: "metric", heading: "X", metric: { value: "[[CLAIM src=made.up]]", label: "x" } };
		const out = verifySlideSpec(spec, opts());
		expect(out.spec.metric?.value).toBe("unknown");
		expect(out.assertedFields).toContain("metric.value");
	});

	it("marks a bullet by its index, not the whole slide", () => {
		const spec: SlideSpec = {
			layout: "bullets",
			heading: "H",
			bullets: ["plain text", "[[CLAIM src=made.up expect=7]]", "also plain"],
		};
		expect(verifySlideSpec(spec, opts()).assertedFields).toEqual(["bullets.1"]);
	});

	it("leaves fields with no reference untouched", () => {
		const spec: SlideSpec = { layout: "bullets", heading: "Plain", bullets: ["nothing to resolve"] };
		const out = verifySlideSpec(spec, opts());
		expect(out.spec).toEqual(spec);
		expect(out.assertedFields).toEqual([]);
	});

	it("does not substitute inside a code block the officer is quoting", () => {
		const spec: SlideSpec = { layout: "code", heading: "H", code: { lang: "bash", text: "echo [[CLAIM src=git.head]]" } };
		expect(verifySlideSpec(spec, opts()).spec.code?.text).toBe("echo [[CLAIM src=git.head]]");
	});

	it("refuses a path outside the permitted roots", () => {
		const spec: SlideSpec = {
			layout: "metric",
			heading: "X",
			metric: { value: "[[CLAIM src=file.lines path=/etc/passwd expect=1]]", label: "x" },
		};
		expect(verifySlideSpec(spec, opts()).assertedFields).toContain("metric.value");
	});

	it("carries the marking through to visible pixels", () => {
		const spec: SlideSpec = {
			layout: "metric",
			heading: "Lines",
			metric: { value: `[[CLAIM src=file.lines path=${join(repo, "a.txt")} expect=999]]`, label: "lines" },
		};
		const out = verifySlideSpec(spec, opts());
		const { html } = renderSlide(out.spec, { code: "8TO", name: "Rishi", index: 1, assertedFields: out.assertedFields });
		expect(html).toContain("ASSERTED");
	});
});

describe("voice selection is declared, never inferred", () => {
	it("gives the same officer the same voice every time", () => {
		for (const code of ["8EO", "8TO", "8PO", "8DO", "8SO", "8CO", "8MO", "8GO"]) {
			expect(voiceFor(code)).toEqual(voiceFor(code));
			expect(voiceFor(code)).toEqual(voiceFor(code.toLowerCase()));
		}
	});

	it("gives different officers distinguishable identities", () => {
		expect(voiceFor("8TO").say).not.toBe(voiceFor("8PO").say);
	});

	it("never depends on message content", async () => {
		const source = await Bun.file(new URL("../huddle-voice.ts", import.meta.url)).text();
		// voiceFor takes only a code. If it ever grows a text argument or a
		// keyword table, the Voice Experience Contract's point 2 is broken.
		expect(source).toContain("export function voiceFor(code: string)");
		expect(source).not.toContain("Math.random");
	});
});
