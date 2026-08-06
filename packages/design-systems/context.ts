/**
 * Universal Design Context
 *
 * One resolver every generation surface (pdf / deck / html / react) pulls from
 * so an artifact inherits our design tokens regardless of which model wrote it.
 * Structure carries the taste - a weak local model still ships our palette,
 * type scale and component classes because they come from the index, not the
 * weights.
 *
 * Spec: docs/specs/UNIVERSAL-DESIGN-CONTEXT.md
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { getDatabaseStats, initDatabase } from "./db";
import {
	featured,
	generateCssVariables,
	generateTailwindConfig,
	getComplete,
	getHexPalette,
	search,
	suggestForProject,
} from "./query";

/** Thrown when no seeded design-system DB is reachable. Fail-closed: a surface
 * must NOT silently render un-branded, so callers on shared/prod paths let this
 * propagate rather than swallow it. */
export class DesignContextUnavailable extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DesignContextUnavailable";
	}
}

export interface DesignContext {
	/** Stable id of the resolved design system (stamp this on artifact metadata). */
	systemId: string;
	/** Human name, e.g. "Vercel", "Cosmic Night". */
	name: string;
	/** :root { --theme-* } block, from generateCssVariables(). */
	cssVariables: string;
	/** Tailwind theme fragment, from generateTailwindConfig(). */
	tailwindConfig: object;
	/** Hex palette keyed by role (primary, accent, background, ...). */
	hexPalette: Record<string, string>;
	typography: { headingFont: string; bodyFont: string; scale: string[] };
	/** Pre-rendered instruction a generator prepends so the model honors the tokens. */
	promptBlock: string;
}

export interface DesignHint {
	/** Explicit system id or name - wins over everything else. */
	systemId?: string;
	/** Project type fed to suggestForProject() (e.g. "saas", "gaming", "health"). */
	projectType?: string;
	/** Free text (the brief) used for search() when no type/id is given. */
	freeText?: string;
	/** Bias suggestions toward dark/light. */
	preferDark?: boolean;
	preferLight?: boolean;
}

let dbReady = false;

/** Test-only: clear the DB cache so a newly-set EIGHT_DESIGN_DB takes effect on
 * the next resolve. Not part of the public generation contract. */
export function __resetDesignContextCache(): void {
	dbReady = false;
}

/** Locate + initialize the design DB, mirroring the pipeline's candidate order.
 * Throws DesignContextUnavailable if missing or empty (fail-closed). */
function ensureDb(): void {
	if (dbReady) return;
	const candidates = [
		// EIGHT_DESIGN_DB lets an operator / test point generation at a specific
		// seeded DB (also the hook a "design DB" setting can drive).
		process.env.EIGHT_DESIGN_DB,
		join(process.cwd(), "data", "design-systems.db"),
		join(homedir(), ".8gent", "design-systems.db"),
	].filter((p): p is string => Boolean(p));
	const dbPath = candidates.find((p) => existsSync(p));
	if (!dbPath) {
		throw new DesignContextUnavailable(
			`No design-systems DB found (looked in: ${candidates.join(", ")}). ` +
				`Run the seed (seedDatabase) before generating on a shared surface.`,
		);
	}
	initDatabase(dbPath);
	if (getDatabaseStats().totalSystems === 0) {
		throw new DesignContextUnavailable(
			`Design-systems DB at ${dbPath} has 0 systems - reseed before generating.`,
		);
	}
	dbReady = true;
}

/** Pick the single systemId this job will use, given a hint. Deterministic:
 * explicit id/name > project-type suggestion > free-text search > featured. */
function pickSystemId(hint: DesignHint): string {
	if (hint.systemId) {
		const c = getComplete(hint.systemId);
		if (c) return c.system.id;
		// fall through - an unknown explicit id degrades to suggestion, never to bare
	}
	if (hint.projectType) {
		const s = suggestForProject(hint.projectType, {
			preferDark: hint.preferDark,
			preferLight: hint.preferLight,
			maxResults: 1,
		});
		if (s.length > 0) return s[0].system.system.id;
	}
	if (hint.freeText && hint.freeText.trim()) {
		const found = search(hint.freeText.trim());
		if (found.length > 0) return found[0].id;
	}
	// featured() returns CompleteDesignSystem[], so reach through .system.id.
	const feat = featured();
	if (feat.length > 0) return feat[0].system.id;
	throw new DesignContextUnavailable(
		"DB has systems but none resolved for the hint - this should not happen; check seed integrity.",
	);
}

/**
 * Resolve one DesignContext for a generation job. Call ONCE per request and
 * thread the returned systemId through every surface so a PDF, a deck and a
 * React app of the same request are visually identical.
 */
export function resolveDesignContext(hint: DesignHint = {}): DesignContext {
	ensureDb();
	const systemId = pickSystemId(hint);

	const complete = getComplete(systemId);
	const css = generateCssVariables(systemId);
	const tw = generateTailwindConfig(systemId);
	const hex = getHexPalette(systemId);
	if (!complete || !css || !tw || !hex) {
		throw new DesignContextUnavailable(
			`Resolved systemId "${systemId}" is missing palette/typography rows - reseed.`,
		);
	}

	const headingFont = complete.typography?.heading_font ?? "system-ui";
	const bodyFont = complete.typography?.font_family ?? "system-ui";
	let scale: string[] = [];
	const rawScale = complete.typography?.heading_sizes_json;
	if (rawScale) {
		try {
			const parsed = JSON.parse(rawScale);
			scale = Array.isArray(parsed) ? parsed.map(String) : Object.values(parsed).map(String);
		} catch {
			scale = [];
		}
	}

	const ctx: DesignContext = {
		systemId,
		name: complete.system.label || complete.system.name,
		cssVariables: css,
		tailwindConfig: tw,
		hexPalette: hex,
		typography: { headingFont, bodyFont, scale },
		promptBlock: "",
	};
	ctx.promptBlock = designPromptBlock(ctx);
	return ctx;
}

/**
 * Compact, model-agnostic instruction a generator prepends. This is how the
 * structure out-does the weights: every model, strong or weak, is told to use
 * ONLY these tokens, so the output inherits the design.
 */
export function designPromptBlock(ctx: DesignContext): string {
	const hex = ctx.hexPalette;
	const line = (k: string) => (hex[k] ? `${k}: ${hex[k]}` : null);
	const palette = ["primary", "accent", "background", "foreground", "card", "border"]
		.map(line)
		.filter(Boolean)
		.join(", ");
	return [
		`## Design system: ${ctx.name} (id: ${ctx.systemId})`,
		`Use ONLY this design system. Do not invent colors, fonts, or spacing.`,
		``,
		`Palette (hex): ${palette}.`,
		`Heading font: ${ctx.typography.headingFont}. Body font: ${ctx.typography.bodyFont}.`,
		ctx.typography.scale.length ? `Heading scale: ${ctx.typography.scale.join(" / ")}.` : ``,
		``,
		`CSS variables to apply verbatim:`,
		ctx.cssVariables,
	]
		.filter((l) => l !== ``)
		.join("\n");
}
