/**
 * 8gent Code - make_xlsx core (#4274).
 *
 * The model writes sheets as rows of cells; this code writes SpreadsheetML.
 * Strings go to the shared-strings table, numbers and booleans are typed, a
 * cell can carry a formula and a number format, and dates become serial days
 * with a date format. Formulas are stored without a cached value and the
 * workbook asks for a full recalculation on open. Formulas may call only an
 * allowlist of local functions, and external links and DDE refs are refused,
 * so that recalculation never reaches outside the workbook. Never a macro part.
 */

import { z } from "zod";
import { XML_HEAD, appXml, coreXml, esc, parseSpec } from "./common";
import { writeZip } from "./zip";

const scalar = z.union([z.string().max(32767), z.number(), z.boolean(), z.null()]);

export const XlsxCellSchema = z.union([
	scalar,
	z
		.object({
			value: scalar.optional(),
			formula: z.string().max(4000).optional(),
			date: z
				.string()
				.regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD")
				.optional(),
			format: z.string().max(100).optional(),
			bold: z.boolean().optional(),
		})
		.strict(),
]);

export const XlsxSheetSchema = z
	.object({
		name: z.string().min(1).max(31),
		rows: z.array(z.array(XlsxCellSchema).max(1000)).max(100000),
		columns: z.array(z.number().min(1).max(255)).max(1000).optional(),
		header: z.boolean().optional(),
	})
	.strict();

export const XlsxSpecSchema = z
	.object({
		title: z.string().max(300).optional(),
		sheets: z.array(XlsxSheetSchema).min(1).max(100),
	})
	.strict();

export type XlsxCell = z.infer<typeof XlsxCellSchema>;
export type XlsxSpec = z.infer<typeof XlsxSpecSchema>;

/** Cells across every sheet. */
export const MAX_XLSX_CELLS = 500_000;

/** Excel's built-in number formats a spec can name directly; anything else is a custom code. */
const BUILTIN_FORMATS: Record<string, number> = {
	General: 0,
	"0": 1,
	"0.00": 2,
	"#,##0": 3,
	"#,##0.00": 4,
	"0%": 9,
	"0.00%": 10,
	"0.00E+00": 11,
	"mm-dd-yy": 14,
};

/**
 * The only functions a formula may call (#4274 review, 8SO). An allowlist, not a blocklist: the
 * workbook recalculates on open, so any function that can fetch (IMAGE, WEBSERVICE, STOCKHISTORY),
 * link out (HYPERLINK), build a reference from text (INDIRECT) or read the host (CELL, INFO) would
 * run on the reader's machine. These are the classic local math, statistics, logic, text, date,
 * lookup and finance functions; none of them reads anything outside the workbook.
 */
export const ALLOWED_FUNCTIONS: ReadonlySet<string> = new Set(
	(
		"ABS CEILING FLOOR INT MOD POWER PRODUCT ROUND ROUNDDOWN ROUNDUP SQRT SUM SUMIF SUMIFS SUMPRODUCT " +
		"SUMSQ TRUNC EXP LN LOG LOG10 PI SIGN EVEN ODD FACT GCD LCM QUOTIENT RAND RANDBETWEEN MROUND " +
		"DEGREES RADIANS SIN COS TAN ASIN ACOS ATAN ATAN2 " +
		"AVERAGE AVERAGEA AVERAGEIF AVERAGEIFS COUNT COUNTA COUNTBLANK COUNTIF COUNTIFS MAX MAXA MIN MINA " +
		"MEDIAN MODE STDEV STDEVP VAR VARP LARGE SMALL RANK PERCENTILE QUARTILE CORREL " +
		"AND OR NOT IF IFERROR TRUE FALSE " +
		"CONCATENATE LEFT RIGHT MID LEN LOWER UPPER PROPER TRIM TEXT VALUE FIND SEARCH SUBSTITUTE " +
		"REPLACE REPT EXACT CHAR CODE CLEAN FIXED DOLLAR " +
		"DATE DAY MONTH YEAR TODAY NOW WEEKDAY EDATE EOMONTH NETWORKDAYS WORKDAY DATEDIF DATEVALUE " +
		"HOUR MINUTE SECOND TIME WEEKNUM YEARFRAC DAYS360 " +
		"VLOOKUP HLOOKUP LOOKUP INDEX MATCH CHOOSE ROW ROWS COLUMN COLUMNS OFFSET " +
		"ISBLANK ISERROR ISERR ISNA ISNUMBER ISTEXT ISLOGICAL NA N T " +
		"PMT PV FV NPV IRR RATE NPER IPMT PPMT"
	).split(" "),
);

/**
 * One left-to-right pass over a formula, the way Excel reads it: whichever quote opens first owns
 * the span until its own closing quote ("" and '' are escapes inside their own kind only), so a
 * double quote inside a quoted sheet name cannot hide a call (#4274 review, 8SO).
 *   code:  string literals emptied, quoted sheet names kept (external refs live there).
 *   calls: both emptied, so only real function calls are left to check.
 */
function scanQuotes(body: string, f: string): { code: string; calls: string } {
	let code = "";
	let calls = "";
	let i = 0;
	while (i < body.length) {
		const ch = body[i];
		if (ch !== '"' && ch !== "'") {
			code += ch;
			calls += ch;
			i++;
			continue;
		}
		let j = i + 1;
		for (;;) {
			if (j >= body.length) throw new Error(`formula "${f}" has an unclosed ${ch} quote`);
			if (body[j] === ch) {
				if (body[j + 1] === ch) {
					j += 2;
					continue;
				}
				break;
			}
			j++;
		}
		const span = body.slice(i, j + 1);
		code += ch === '"' ? '""' : span;
		calls += ch === '"' ? '""' : "''";
		i = j + 1;
	}
	return { code, calls };
}

/** The formula text without its leading "=", or a plain reason it is refused. */
export function checkFormula(f: string): string {
	const body = f.trim().replace(/^=/, "");
	if (!body) throw new Error("formula is empty");
	// Outside string literals: no external workbook ref ([Book]Sheet!A1, 'C:\[Book]S'!A1), no DDE (app|topic!item).
	const { code, calls } = scanQuotes(body, f);
	if (code.includes("[")) throw new Error(`formula "${f}" refers to another workbook`);
	if (code.includes("|")) throw new Error(`formula "${f}" looks like a DDE link`);
	// Every call must be on the allowlist. Quoted sheet names ('Q1 (draft)'!A1) are not calls.
	for (const m of calls.matchAll(/([A-Za-z_\\][A-Za-z0-9_.\\]*)\s*\(/g)) {
		const name = m[1].toUpperCase();
		if (!ALLOWED_FUNCTIONS.has(name)) {
			throw new Error(`formula "${f}" calls ${name}, which is not on the local function allowlist`);
		}
	}
	return body;
}

/** "A", "B", ... "Z", "AA" for a zero-based column index. */
export function colName(i: number): string {
	let n = i + 1;
	let s = "";
	while (n > 0) {
		const r = (n - 1) % 26;
		s = String.fromCharCode(65 + r) + s;
		n = Math.floor((n - 1) / 26);
	}
	return s;
}

/** Days since 1899-12-30, Excel's serial date (correct for every date after 1900-03-01). */
export function dateSerial(iso: string): number {
	const [y, m, d] = iso.split("-").map(Number);
	const t = Date.UTC(y, m - 1, d);
	const back = new Date(t);
	if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) {
		throw new Error(`date "${iso}" is not a real calendar date`);
	}
	return (t - Date.UTC(1899, 11, 30)) / 86400000;
}

const INVALID_SHEET_CHARS = /[\\/?*[\]:"]/;

class Styles {
	private custom = new Map<string, number>();
	private xfs = new Map<string, number>([["0:0", 0]]);
	private order: Array<{ numFmt: number; bold: boolean }> = [{ numFmt: 0, bold: false }];

	index(format: string | undefined, bold: boolean): number {
		let numFmt = 0;
		if (format !== undefined && format !== "") {
			if (format in BUILTIN_FORMATS) numFmt = BUILTIN_FORMATS[format];
			else {
				numFmt = this.custom.get(format) ?? 164 + this.custom.size;
				this.custom.set(format, numFmt);
			}
		}
		const key = `${numFmt}:${bold ? 1 : 0}`;
		let i = this.xfs.get(key);
		if (i === undefined) {
			i = this.order.length;
			this.xfs.set(key, i);
			this.order.push({ numFmt, bold });
		}
		return i;
	}

	xml(): string {
		const fmts = [...this.custom].map(
			([code, id]) => `<numFmt numFmtId="${id}" formatCode="${esc(code)}"/>`,
		);
		const numFmts = fmts.length ? `<numFmts count="${fmts.length}">${fmts.join("")}</numFmts>` : "";
		const xfs = this.order.map(
			(x) =>
				`<xf numFmtId="${x.numFmt}" fontId="${x.bold ? 1 : 0}" fillId="0" borderId="0" xfId="0"${x.numFmt ? ' applyNumberFormat="1"' : ""}${x.bold ? ' applyFont="1"' : ""}/>`,
		);
		return (
			`${XML_HEAD}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${numFmts}` +
			'<fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts>' +
			'<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
			'<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
			'<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
			`<cellXfs count="${xfs.length}">${xfs.join("")}</cellXfs>` +
			'<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
			"</styleSheet>"
		);
	}
}

class SharedStrings {
	private map = new Map<string, number>();
	private list: string[] = [];
	count = 0;
	index(s: string): number {
		this.count++;
		let i = this.map.get(s);
		if (i === undefined) {
			i = this.list.length;
			this.map.set(s, i);
			this.list.push(s);
		}
		return i;
	}
	xml(): string {
		const items = this.list.map((s) => `<si><t xml:space="preserve">${esc(s)}</t></si>`).join("");
		return `${XML_HEAD}<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${this.count}" uniqueCount="${this.list.length}">${items}</sst>`;
	}
}

function cellXml(
	ref: string,
	cell: XlsxCell,
	styles: Styles,
	sst: SharedStrings,
	headerBold: boolean,
): string {
	const obj = cell !== null && typeof cell === "object" ? cell : { value: cell };
	let format = obj.format;
	let value = obj.value;
	if (obj.date !== undefined) {
		value = dateSerial(obj.date);
		format = format ?? "yyyy-mm-dd";
	}
	const s = styles.index(format, obj.bold ?? headerBold);
	const sAttr = s ? ` s="${s}"` : "";
	if (obj.formula !== undefined) {
		return `<c r="${ref}"${sAttr}><f>${esc(checkFormula(obj.formula))}</f></c>`;
	}
	if (value === null || value === undefined || value === "")
		return sAttr ? `<c r="${ref}"${sAttr}/>` : "";
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new Error(`cell ${ref} is not a finite number`);
		return `<c r="${ref}"${sAttr}><v>${value}</v></c>`;
	}
	if (typeof value === "boolean") return `<c r="${ref}"${sAttr} t="b"><v>${value ? 1 : 0}</v></c>`;
	return `<c r="${ref}"${sAttr} t="s"><v>${sst.index(value)}</v></c>`;
}

export interface XlsxBuild {
	buffer: Buffer;
	sheets: number;
	cells: number;
}

/** Build the .xlsx bytes for a spec. */
export function buildXlsx(rawSpec: unknown): XlsxBuild {
	const spec = parseSpec(XlsxSpecSchema, rawSpec, "make_xlsx");
	const styles = new Styles();
	const sst = new SharedStrings();
	const seen = new Set<string>();
	let cells = 0;
	const sheetXml: string[] = [];

	for (const sheet of spec.sheets) {
		if (INVALID_SHEET_CHARS.test(sheet.name) || /^'|'$/.test(sheet.name)) {
			throw new Error(
				`sheet name "${sheet.name}" has a character that is not allowed (\\ / ? * [ ] : " or an edge ')`,
			);
		}
		const key = sheet.name.toLowerCase();
		if (seen.has(key)) throw new Error(`sheet name "${sheet.name}" is used twice`);
		seen.add(key);

		const rows = sheet.rows.map((row, ri) => {
			cells += row.length;
			if (cells > MAX_XLSX_CELLS)
				throw new Error(`make_xlsx holds at most ${MAX_XLSX_CELLS} cells`);
			const bold = sheet.header === true && ri === 0;
			const cs = row.map((cell, ci) => {
				const ref = `${colName(ci)}${ri + 1}`;
				try {
					return cellXml(ref, cell, styles, sst, bold);
				} catch (err) {
					const why = err instanceof Error ? err.message : String(err);
					throw new Error(`sheet "${sheet.name}" cell ${ref}: ${why}`);
				}
			});
			return `<row r="${ri + 1}">${cs.join("")}</row>`;
		});
		const view = sheet.header
			? '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
			: '<sheetViews><sheetView workbookViewId="0"/></sheetViews>';
		const cols = sheet.columns?.length
			? `<cols>${sheet.columns.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols>`
			: "";
		sheetXml.push(
			`${XML_HEAD}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${view}<sheetFormatPr defaultRowHeight="15"/>${cols}<sheetData>${rows.join("")}</sheetData></worksheet>`,
		);
	}

	const n = spec.sheets.length;
	const sheetsList = spec.sheets
		.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
		.join("");
	const workbook =
		`${XML_HEAD}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
		`<bookViews><workbookView/></bookViews><sheets>${sheetsList}</sheets><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>`;
	const wbRels =
		`${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
		spec.sheets
			.map(
				(_, i) =>
					`<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
			)
			.join("") +
		`<Relationship Id="rId${n + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
		`<Relationship Id="rId${n + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>` +
		"</Relationships>";
	const types =
		`${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
		'<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
		'<Default Extension="xml" ContentType="application/xml"/>' +
		'<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
		spec.sheets
			.map(
				(_, i) =>
					`<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
			)
			.join("") +
		'<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
		'<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>' +
		'<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
		'<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
		"</Types>";
	const rootRels =
		`${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
		'<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
		'<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
		'<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>' +
		"</Relationships>";

	const buffer = writeZip([
		{ name: "[Content_Types].xml", data: types },
		{ name: "_rels/.rels", data: rootRels },
		{ name: "docProps/core.xml", data: coreXml(spec.title) },
		{ name: "docProps/app.xml", data: appXml() },
		{ name: "xl/workbook.xml", data: workbook },
		{ name: "xl/_rels/workbook.xml.rels", data: wbRels },
		...sheetXml.map((data, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data })),
		{ name: "xl/styles.xml", data: styles.xml() },
		{ name: "xl/sharedStrings.xml", data: sst.xml() },
	]);
	return { buffer, sheets: n, cells };
}
