/**
 * Tests for make_pdf (packages/tools/make-pdf.ts + pdf-writer.ts), #4267.
 *
 * make_pdf renders in-process, so these run the real path: no stub binary and
 * no ~/.8gent/bin/make-pdf. The test preload gives every run a temp $HOME, so
 * "works on a clean HOME" is what each test proves. Output is read back with
 * pdf-parse (packages/tools/pdf.ts), an independent PDF reader.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CREATIVE_DIR, MAX_SOURCE_CHARS, makePdf } from "../make-pdf";
import { readPdf } from "../pdf";
import { htmlToMarkdown, parseMarkdown, winAnsi, writePdf } from "../pdf-writer";

let tmpDir: string;
const made: string[] = [];

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "make-pdf-test-"));
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
	for (const p of made.splice(0)) fs.rmSync(p, { force: true });
});

const keep = <T extends { path: string }>(r: T) => {
	made.push(r.path);
	return r;
};

describe("makePdf renders in-process", () => {
	test("needs no ~/.8gent/bin/make-pdf on a clean HOME", async () => {
		const home = process.env.HOME as string;
		expect(fs.existsSync(path.join(home, ".8gent", "bin", "make-pdf"))).toBe(false);
		const r = keep(
			await makePdf({ markdown: "# Clean home\n\nIt works here.", outName: "clean-home" }),
		);
		expect(r.kind).toBe("document");
		expect(r.path).toBe(path.join(CREATIVE_DIR, "clean-home.pdf"));
		expect(r.pages).toBe(1);
		expect(fs.readFileSync(r.path).subarray(0, 8).toString("latin1")).toBe("%PDF-1.4");
	});

	test("an independent reader gets the text back", async () => {
		const md = [
			"# Weekly report",
			"",
			"Shipped the **media** attachment and `make_pdf`.",
			"",
			"- first point",
			"- second point",
			"",
			"1. ordered one",
			"",
			"> a quote",
			"",
			"```",
			"const x = (1 + 2);",
			"```",
			"",
			"---",
			"",
			"Cafe \u2019quotes\u2019 \u2013 dash \u20ac5",
		].join("\n");
		const r = keep(await makePdf({ markdown: md, outName: "read-back" }));
		const info = await readPdf(r.path);
		expect(info.pageCount).toBe(1);
		for (const s of [
			"Weekly report",
			"Shipped the media attachment and make_pdf.",
			"first point",
			"ordered one",
			"a quote",
			"const x = (1 + 2);",
			"\u20ac5",
		])
			expect(info.text).toContain(s);
		expect(info.text).not.toContain("**");
		expect(r.replaced).toBeUndefined();
		// The first readPdf in the process loads pdf-parse and pdfjs (readPdf imports them lazily):
		// 6-12 s cold on a Windows runner, past the 5 s default. Later tests find it cached.
	}, 30_000);

	test("long input flows onto more pages, each numbered", async () => {
		const para = "word ".repeat(400);
		const r = keep(await makePdf({ markdown: Array(12).fill(para).join("\n\n"), outName: "long" }));
		expect(r.pages).toBeGreaterThan(2);
		const info = await readPdf(r.path);
		expect(info.pageCount).toBe(r.pages);
		expect(info.text).toContain(`${r.pages} / ${r.pages}`);
	});

	test("same input, byte-identical PDF", () => {
		const blocks = parseMarkdown("# Same\n\nOne paragraph.\n\n- item");
		expect(writePdf(blocks, "Same").pdf.equals(writePdf(blocks, "Same").pdf)).toBe(true);
	});

	test("html keeps its structure and drops script and style", async () => {
		const html =
			"<html><head><style>h1{color:red}</style></head><body><h1>From HTML</h1><p>A &amp; B</p><ul><li>one</li><li>two</li></ul><script>alert(1)</script></body></html>";
		const r = keep(await makePdf({ html, outName: "from-html" }));
		const info = await readPdf(r.path);
		expect(info.text).toContain("From HTML");
		expect(info.text).toContain("A & B");
		expect(info.text).toContain("two");
		expect(info.text).not.toContain("alert");
		expect(info.text).not.toContain("color:red");
	});

	test("mdPath and htmlPath read the file", async () => {
		const md = path.join(tmpDir, "brief.md");
		fs.writeFileSync(md, "# From disk\n\nbody");
		const r = keep(await makePdf({ mdPath: md, outName: "from-disk" }));
		expect((await readPdf(r.path)).text).toContain("From disk");
		const html = path.join(tmpDir, "page.html");
		fs.writeFileSync(html, "<h2>Html on disk</h2>");
		const r2 = keep(await makePdf({ htmlPath: html, outName: "html-disk" }));
		expect((await readPdf(r2.path)).text).toContain("Html on disk");
	});

	test("title becomes the heading when the source has none; auto name never overwrites", async () => {
		const a = keep(await makePdf({ markdown: "just body", title: "Auto Name Test" }));
		const b = keep(await makePdf({ markdown: "just body", title: "Auto Name Test" }));
		expect(path.basename(a.path)).toBe("auto-name-test.pdf");
		expect(path.basename(b.path)).toBe("auto-name-test-2.pdf");
		expect((await readPdf(a.path)).text).toContain("Auto Name Test");
	});

	test("outName is kept inside the creative folder", async () => {
		const r = keep(await makePdf({ markdown: "# x", outName: "../../escape/evil" }));
		expect(r.path).toBe(path.join(CREATIVE_DIR, "evil.pdf"));
	});

	test("characters outside the standard fonts are counted, not hidden", async () => {
		const r = keep(
			await makePdf({ markdown: "# Emoji \u{1F680} and \u4e2d", outName: "replaced" }),
		);
		expect(r.replaced).toBe(2);
	});
});

describe("makePdf known-bad input", () => {
	test("no source", async () => {
		await expect(makePdf({ title: "empty" })).rejects.toThrow(/one of/i);
	});

	test("more than one source", async () => {
		await expect(makePdf({ markdown: "# A", html: "<h1>B</h1>" })).rejects.toThrow(
			/exactly one source/i,
		);
	});

	test("a missing mdPath names the file", async () => {
		await expect(makePdf({ mdPath: path.join(tmpDir, "nope.md") })).rejects.toThrow(
			/mdPath not found: .*nope\.md/,
		);
	});

	test("a directory is not a file", async () => {
		await expect(makePdf({ htmlPath: tmpDir })).rejects.toThrow(/htmlPath not found/);
	});

	test("an oversized source is refused before layout", async () => {
		await expect(makePdf({ markdown: "x".repeat(MAX_SOURCE_CHARS + 1) })).rejects.toThrow(
			/at most/,
		);
	});

	test("a source with no text", async () => {
		await expect(makePdf({ html: "<script>only()</script>" })).rejects.toThrow(/no text/);
	});

	test("no file is left behind when a call is refused", async () => {
		const count = () => (fs.existsSync(CREATIVE_DIR) ? fs.readdirSync(CREATIVE_DIR).length : 0);
		const before = count();
		await makePdf({ markdown: "# A", html: "<p>B</p>" }).catch(() => {});
		await makePdf({ markdown: "x".repeat(MAX_SOURCE_CHARS + 1) }).catch(() => {});
		expect(count()).toBe(before);
	});
});

describe("pdf-writer units", () => {
	test("winAnsi maps typographic punctuation and counts the rest", () => {
		const t = { replaced: 0 };
		expect(winAnsi("\u2018a\u2019 \u2014 \u2022", t)).toEqual([
			0x91, 0x61, 0x92, 0x20, 0x97, 0x20, 0x95,
		]);
		winAnsi("\u{1F600}", t);
		expect(t.replaced).toBe(1);
	});

	test("htmlToMarkdown decodes entities and keeps headings", () => {
		const md = htmlToMarkdown("<h2>Hi &lt;there&gt;</h2><p>&#8364;1 &nbsp;x</p>");
		expect(md).toContain("## Hi <there>");
		expect(md).toContain("\u20ac1");
	});

	test("parseMarkdown keeps snake_case and keeps a table as one block without its separator", () => {
		const b = parseMarkdown("call make_pdf_now\n\n| a | b |\n|---|---|\n| 1 | 2 |");
		expect(b[0].text).toBe("call make_pdf_now");
		expect(b.filter((x) => x.kind === "code").map((x) => x.text)).toEqual(["| a | b |\n| 1 | 2 |"]);
	});
});
