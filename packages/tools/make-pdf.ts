/**
 * 8gent Code - make_pdf tool helper
 *
 * PDF *production* (the write-side counterpart of packages/tools/pdf.ts, which
 * reads PDFs). We do NOT reimplement rendering here: we shell out to the
 * canonical, portable renderer installed fleet-wide at ~/.8gent/bin/make-pdf
 * (a Python CLI that walks a weasyprint -> chrome-headless fallback ladder and
 * writes into ~/.8gent/creative/ so the Create surface picks the file up).
 *
 * This module owns only the marshalling: pick the right CLI flags for the
 * given input, capture the absolute PDF path the CLI prints on its LAST stdout
 * line, and hand back the { path, kind: "document" } tool-result contract.
 *
 * Deterministic, no network. Non-destructive: it only writes one new file into
 * the creative folder.
 */

import { resolveHome } from "../core/home";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import {
	type DesignContext,
	type DesignHint,
	DesignContextUnavailable,
	resolveDesignContext,
} from "../design-systems/index";

/** Absolute path to the creative folder the CLI writes into by default. */
export const CREATIVE_DIR = path.join(resolveHome(), ".8gent", "creative");

/** Absolute path to the canonical renderer CLI. Overridable for tests. */
export const DEFAULT_MAKE_PDF_BIN = path.join(resolveHome(), ".8gent", "bin", "make-pdf");

/** Resolve the CLI binary, honouring an env override (used by the test suite). */
export function resolveMakePdfBin(): string {
	return process.env.EIGHT_MAKE_PDF_BIN?.trim() || DEFAULT_MAKE_PDF_BIN;
}

export interface MakePdfInput {
	/** Inline Markdown source. */
	markdown?: string;
	/** Inline HTML source. */
	html?: string;
	/** Path to an existing HTML file on disk. */
	htmlPath?: string;
	/** Path to an existing Markdown file on disk. */
	mdPath?: string;
	/** Document title (used for Markdown inputs and auto-naming). */
	title?: string;
	/**
	 * Optional output filename. Resolved inside the creative folder so the Create
	 * surface always picks the result up. A `.pdf` extension is appended if
	 * missing. Absolute paths and path separators are stripped to a basename to
	 * keep every output inside the creative folder.
	 */
	outName?: string;
	/**
	 * Apply a design system to the PDF so it inherits our tokens like every other
	 * surface. Explicit id wins; otherwise a hint selects one. Best-effort: if no
	 * seeded design DB is reachable the PDF still renders, just unthemed.
	 */
	designSystemId?: string;
	designHint?: DesignHint;
}

export interface MakePdfResult {
	/** Absolute path to the produced PDF, under the creative folder. */
	path: string;
	/** Tool-result kind, so downstream surfaces route it as a document. */
	kind: "document";
	/** The design system the PDF inherited, if any (provenance stamp). */
	designSystemId?: string;
}

/** Coerce an optional outName into a safe absolute path in the creative folder. */
function resolveOutPath(outName: string): string {
	const base = path.basename(outName.trim());
	const named = base.toLowerCase().endsWith(".pdf") ? base : `${base}.pdf`;
	return path.join(CREATIVE_DIR, named);
}

/** A <style> block from a resolved design context: the token variables plus a
 * small base stylesheet mapping them onto document elements, so an actual PDF
 * looks themed. The renderer CLI has no --css flag, so we inject into the HTML. */
function designStyleBlock(ctx: DesignContext): string {
	const { headingFont, bodyFont } = ctx.typography;
	return [
		"<style>",
		ctx.cssVariables,
		`body{background:hsl(var(--theme-background));color:hsl(var(--theme-foreground));font-family:${bodyFont};}`,
		`h1,h2,h3,h4,h5,h6{font-family:${headingFont};color:hsl(var(--theme-foreground));}`,
		`a{color:hsl(var(--theme-primary));}`,
		`code,pre{background:hsl(var(--theme-muted));color:hsl(var(--theme-muted-foreground));}`,
		`hr,table,th,td{border-color:hsl(var(--theme-border));}`,
		"</style>",
	].join("\n");
}

/** Inject the style block into an HTML string (before </head>, else prepend). */
function injectDesign(html: string, ctx: DesignContext): string {
	const style = designStyleBlock(ctx);
	if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, `${style}\n</head>`);
	return `${style}\n${html}`;
}

/** Resolve a design context (when requested) and apply it to the HTML source so
 * the PDF inherits our tokens like every other surface. Best-effort: an
 * unavailable DB leaves the input unthemed rather than blocking the render. */
export function applyDesign(input: MakePdfInput): {
	input: MakePdfInput;
	designSystemId?: string;
} {
	if (input.designSystemId == null && input.designHint == null) return { input };
	let ctx: DesignContext;
	try {
		ctx = resolveDesignContext({
			systemId: input.designSystemId,
			...(input.designHint ?? {}),
		});
	} catch (err) {
		if (err instanceof DesignContextUnavailable) return { input }; // render unthemed
		throw err;
	}
	if (input.html != null && input.html !== "") {
		return {
			input: { ...input, html: injectDesign(input.html, ctx) },
			designSystemId: ctx.systemId,
		};
	}
	if (input.htmlPath != null && input.htmlPath !== "") {
		const raw = fs.readFileSync(path.resolve(input.htmlPath), "utf8");
		const { htmlPath: _drop, ...rest } = input;
		return {
			input: { ...rest, html: injectDesign(raw, ctx) },
			designSystemId: ctx.systemId,
		};
	}
	// Markdown sources: the CLI owns markdown->HTML, so we cannot inject a <style>
	// into raw markdown; still stamp provenance so the surface records the choice.
	return { input, designSystemId: ctx.systemId };
}

/** Build the CLI argument vector for exactly one supplied input source. */
function buildArgs(input: MakePdfInput): string[] {
	const { markdown, html, htmlPath, mdPath, title, outName } = input;
	const sources = [markdown, html, htmlPath, mdPath].filter((v) => v != null && v !== "");
	if (sources.length === 0) {
		throw new Error("make_pdf requires one of: markdown, html, htmlPath, mdPath");
	}
	if (sources.length > 1) {
		throw new Error(
			"make_pdf accepts exactly one source; got multiple of markdown/html/htmlPath/mdPath",
		);
	}

	const args: string[] = [];
	if (markdown != null && markdown !== "") {
		args.push("--markdown-text", markdown);
	} else if (html != null && html !== "") {
		args.push("--html-text", html);
	} else if (htmlPath != null && htmlPath !== "") {
		args.push("--html", path.resolve(htmlPath));
	} else if (mdPath != null && mdPath !== "") {
		args.push("--md", path.resolve(mdPath));
	}

	if (title != null && title !== "") args.push("--title", title);
	if (outName != null && outName !== "") args.push("--out", resolveOutPath(outName));
	return args;
}

/**
 * Produce a PDF via the canonical renderer CLI.
 *
 * Resolves with `{ path, kind: "document" }` on success (the absolute PDF path
 * the CLI printed on its last stdout line). Rejects with the CLI's stderr
 * reason on a non-zero exit.
 */
export function makePdf(input: MakePdfInput): Promise<MakePdfResult> {
	return new Promise((resolve, reject) => {
		let designed: { input: MakePdfInput; designSystemId?: string };
		try {
			designed = applyDesign(input);
		} catch (err) {
			reject(err);
			return;
		}
		let args: string[];
		try {
			args = buildArgs(designed.input);
		} catch (err) {
			reject(err);
			return;
		}
		const bin = resolveMakePdfBin();

		if (!fs.existsSync(bin)) {
			reject(new Error(`make-pdf renderer not found at ${bin}`));
			return;
		}

		const proc = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";

		proc.stdout.on("data", (d) => {
			stdout += d.toString();
		});
		proc.stderr.on("data", (d) => {
			stderr += d.toString();
		});
		proc.on("error", (err) => reject(err));
		proc.on("close", (code) => {
			if (code !== 0) {
				const reason = stderr.trim() || `make-pdf exited with code ${code}`;
				reject(new Error(reason));
				return;
			}
			const lines = stdout
				.trim()
				.split("\n")
				.map((l) => l.trim())
				.filter(Boolean);
			const outPath = lines[lines.length - 1];
			if (!outPath) {
				reject(new Error("make-pdf produced no output path"));
				return;
			}
			resolve({ path: outPath, kind: "document", designSystemId: designed.designSystemId });
		});
	});
}
