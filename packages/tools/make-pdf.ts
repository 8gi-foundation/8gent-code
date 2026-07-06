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

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Absolute path to the creative folder the CLI writes into by default. */
export const CREATIVE_DIR = path.join(os.homedir(), ".8gent", "creative");

/** Absolute path to the canonical renderer CLI. Overridable for tests. */
export const DEFAULT_MAKE_PDF_BIN = path.join(os.homedir(), ".8gent", "bin", "make-pdf");

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
}

export interface MakePdfResult {
	/** Absolute path to the produced PDF, under the creative folder. */
	path: string;
	/** Tool-result kind, so downstream surfaces route it as a document. */
	kind: "document";
}

/** Coerce an optional outName into a safe absolute path in the creative folder. */
function resolveOutPath(outName: string): string {
	const base = path.basename(outName.trim());
	const named = base.toLowerCase().endsWith(".pdf") ? base : `${base}.pdf`;
	return path.join(CREATIVE_DIR, named);
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
		let args: string[];
		try {
			args = buildArgs(input);
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
			resolve({ path: outPath, kind: "document" });
		});
	});
}
