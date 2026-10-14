/**
 * 8gent Code - make_pdf tool helper
 *
 * PDF *production* (the write-side counterpart of packages/tools/pdf.ts, which
 * reads PDFs). Rendering happens in this process via ./pdf-writer (#4267): it
 * used to shell out to ~/.8gent/bin/make-pdf, which a fresh install does not
 * have, so the tool was offered and then failed mid-task.
 *
 * Output lands in ~/.8gent/creative/ so the Create surface picks it up.
 * Deterministic, no network. Non-destructive: an auto-named file never
 * overwrites one already there.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { resolveHome } from "../core/home";
import { type Block, htmlToMarkdown, parseMarkdown, writePdf } from "./pdf-writer";

import {
	type DesignContext,
	DesignContextUnavailable,
	type DesignHint,
	resolveDesignContext,
} from "../design-systems/index";

/** Absolute path to the creative folder make_pdf writes into. */
export const CREATIVE_DIR = path.join(resolveHome(), ".8gent", "creative");

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
	/** Pages laid out. */
	pages: number;
	/** Characters outside the standard fonts, printed as "?" (absent when none). */
	replaced?: number;
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
 * small base stylesheet mapping them onto document elements. The in-process
 * writer does not apply CSS, so today this records the choice (provenance)
 * and keeps the themed HTML ready for a CSS-aware renderer. */
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
 * unavailable DB leaves the input unthemed rather than blocking the render.
 * Reads no files: makePdf turns htmlPath into inline html first, through the
 * workspace confinement in loadFileSources. */
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
	// Markdown sources have no <style> to inject into; still stamp provenance.
	return { input, designSystemId: ctx.systemId };
}

/** Largest source make_pdf will lay out (characters). */
export const MAX_SOURCE_CHARS = 2_000_000;

/** Exactly one source; throws a plain reason the model can act on. */
function checkOneSource(input: MakePdfInput): void {
	const { markdown, html, htmlPath, mdPath } = input;
	const sources = [markdown, html, htmlPath, mdPath].filter((v) => v != null && v !== "");
	if (sources.length === 0) {
		throw new Error("make_pdf requires one of: markdown, html, htmlPath, mdPath");
	}
	if (sources.length > 1) {
		throw new Error(
			"make_pdf accepts exactly one source; got multiple of markdown/html/htmlPath/mdPath",
		);
	}
}

export interface MakePdfOptions {
	/**
	 * Workspace root that mdPath and htmlPath must stay inside. Required for a
	 * file source: the path is confined by the same safePath(read) check that
	 * read_file uses (traversal, symlink escape, credential files, `~`).
	 */
	workingDirectory?: string;
}

/**
 * Read an mdPath or htmlPath source and hand it back as inline markdown or html,
 * so nothing after this point touches the disk. The path goes through safePath
 * with read access, exactly as read_file does (#3747), so a file read_file
 * refuses is refused here too. Fails closed when no workspace root is given.
 */
async function loadFileSources(input: MakePdfInput, opts: MakePdfOptions): Promise<MakePdfInput> {
	const { htmlPath, mdPath, ...rest } = input;
	const p = mdPath || htmlPath;
	if (!p) return input;
	const label = mdPath ? "mdPath" : "htmlPath";
	if (!opts.workingDirectory)
		throw new Error(`${label} needs a workspace root to stay inside; nothing was read`);
	if (p.includes("\0"))
		throw new Error(`${label} contains a null byte, which is not allowed in a file path`);
	const { safePath } = await import("../eight/tools");
	const abs = safePath(p, opts.workingDirectory, "read");
	if (!fs.existsSync(abs) || !fs.statSync(abs).isFile())
		throw new Error(`${label} not found: ${p}`);
	if (fs.statSync(abs).size > MAX_SOURCE_CHARS * 4)
		throw new Error(`${label} is too large to lay out (over ${MAX_SOURCE_CHARS} characters)`);
	const text = fs.readFileSync(abs, "utf8");
	return mdPath ? { ...rest, markdown: text } : { ...rest, html: text };
}

/** The inline source as Markdown, size-checked. */
function readSource(input: MakePdfInput): { markdown: string } {
	const md = input.markdown ? input.markdown : htmlToMarkdown(input.html ?? "");
	if (md.length > MAX_SOURCE_CHARS)
		throw new Error(
			`source is ${md.length} characters; make_pdf lays out at most ${MAX_SOURCE_CHARS}`,
		);
	return { markdown: md };
}

/** A file name from the title or first heading; never overwrites an existing file. */
function autoOutPath(title: string | undefined, blocks: Block[]): string {
	const seed = title || blocks.find((b) => b.kind === "h1")?.text || "document";
	const slug =
		seed
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 60) || "document";
	let candidate = path.join(CREATIVE_DIR, `${slug}.pdf`);
	for (let n = 2; fs.existsSync(candidate); n++)
		candidate = path.join(CREATIVE_DIR, `${slug}-${n}.pdf`);
	return candidate;
}

/**
 * Produce a PDF in-process (#4267): no external renderer, so there is no
 * missing-binary failure mode. Markdown is laid out directly; HTML keeps its
 * structure (headings, paragraphs, lists, pre) but not its CSS.
 *
 * Resolves with `{ path, kind: "document", pages }`; `replaced` counts
 * characters outside the PDF standard fonts that were printed as "?".
 * Rejects with a plain reason (no source, two sources, missing or oversized
 * file, a path outside the workspace or a credential file, over the page cap).
 */
export async function makePdf(
	input: MakePdfInput,
	opts: MakePdfOptions = {},
): Promise<MakePdfResult> {
	checkOneSource(input);
	const designed = applyDesign(await loadFileSources(input, opts));
	const { markdown } = readSource(designed.input);
	let blocks = parseMarkdown(markdown);
	const title = input.title?.trim() || undefined;
	if (title && blocks[0]?.kind !== "h1") blocks = [{ kind: "h1", text: title }, ...blocks];
	if (blocks.length === 0) throw new Error("make_pdf: the source has no text to lay out");
	const { pdf, pages, replaced } = writePdf(
		blocks,
		title ?? blocks.find((b) => b.kind === "h1")?.text,
	);
	fs.mkdirSync(CREATIVE_DIR, { recursive: true });
	const out = input.outName?.trim() ? resolveOutPath(input.outName) : autoOutPath(title, blocks);
	const tmp = `${out}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, pdf);
	fs.renameSync(tmp, out);
	return {
		path: out,
		kind: "document",
		pages,
		...(replaced ? { replaced } : {}),
		...(designed.designSystemId ? { designSystemId: designed.designSystemId } : {}),
	};
}
