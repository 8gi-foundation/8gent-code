/**
 * 8gent Huddle - the deterministic slide renderer (spec section 4.6).
 *
 *   render(spec, ctx) -> { html, sha256 }
 *
 * PURE. No Date.now(), no Math.random(), no locale-dependent formatting, no
 * network, no filesystem read. Same spec plus same theme yields byte-identical
 * HTML, therefore an identical sha256. The hash is stamped into the manifest
 * and the transcript, so anyone can re-derive a huddle's visuals and confirm
 * they match. That is the 2026-08-03 provenance rule applied to pixels.
 *
 * SECURITY (spec 4.3): every officer-supplied string is HTML-escaped HERE, in
 * the renderer, not in the parser - so a spec that reaches this function by any
 * path is escaped. Templates are TypeScript template literals. There is no
 * template language, no eval, no Function, no dynamic import, and no
 * spec-driven filesystem read. The worst a fully adversarial officer achieves
 * is an ugly slide.
 *
 * DESIGN (the change of 2026-08-07): this file no longer carries a palette or a
 * type scale. Every colour, size, line height, weight, tracking, radius, gap
 * and margin below comes from a SlideTheme composed by packages/design-compose
 * from the huddle id - one design per huddle, so a deliberation has visual
 * coherence across its turns instead of eight unrelated cards. The brand rules
 * (no hue in 270-350) and the WCAG 2.2 contrast floors are enforced by that
 * package's constraint gate, which REFUSES rather than corrects. Nothing here
 * re-implements them. See slide-theme.ts.
 *
 * HONESTY (the constraint that matters most): a value the system did not
 * verify is NOT stated flatly. `assertedFields` carries the set of field paths
 * whose claim reference failed to resolve, and every one of them renders with a
 * visible ASSERTED chip. An unverified number never looks like a verified one.
 */

import { createHash } from "node:crypto";
import type { SlideSpec } from "./slide-spec";
import { accentFor, CANVAS_H, CANVAS_W, themeFor, type OfficerAccent, type SlideTheme } from "./slide-theme";

/** Bump when any template below changes. Part of the hash input, so a template
 *  change is visible as a hash change rather than a silent redesign. */
export const THEME_VERSION = "huddle-composed-1";

/** Everything the renderer needs beyond the spec itself. All of it declared,
 *  none of it inferred, none of it sampled from a clock. */
export interface RenderContext {
	/** Officer code, e.g. "8TO", or "HUMAN" for a James turn. */
	code: string;
	/** Display name, e.g. "Rishi" or "James". */
	name: string;
	/** 1-based position in the deck, for the progress rail. */
	index: number;
	/** Total slides, when known at render time. 0 renders a growing rail. */
	total?: number;
	/**
	 * Dotted paths of fields carrying a value the verifier could NOT confirm
	 * (e.g. "metric.value", "bullets.1"). Each renders an ASSERTED chip.
	 */
	assertedFields?: readonly string[];
	/**
	 * The huddle this slide belongs to. THIS is what makes a deck cohere: the
	 * whole design is composed from it. Absent (a preview, a test, a one-off
	 * render) falls back to a stable default design rather than to a hand-written
	 * theme, so there is exactly one code path.
	 */
	huddleId?: string;
}

// ── Escaping (spec 4.3 layer 2) ────────────────────────────────────────────

/** Same discipline as hypervideo.py::_esc. Applied to EVERY interpolation. */
export function esc(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ── Colour helpers (pure, deterministic, no colour science) ────────────────

/**
 * A theme hex at an alpha. The renderer never invents a colour - it only ever
 * makes one from the composed palette translucent, for washes and hairlines
 * that sit under content. Contrast-bearing colours are used at full opacity,
 * because a gated ratio stops being a gated ratio the moment you fade it.
 */
function alpha(hex: string, a: number): string {
	const r = Number.parseInt(hex.slice(1, 3), 16);
	const g = Number.parseInt(hex.slice(3, 5), 16);
	const b = Number.parseInt(hex.slice(5, 7), 16);
	return `rgba(${r}, ${g}, ${b}, ${a})`;
}

// ── The ASSERTED chip ──────────────────────────────────────────────────────

function isAsserted(ctx: RenderContext, path: string): boolean {
	return ctx.assertedFields?.includes(path) ?? false;
}

/**
 * Wrap a rendered value with a visible ASSERTED marker when it is unverified.
 * The chip is text, not colour alone, so it survives a greyscale frame grab and
 * a screen reader. Honesty must not depend on a hue.
 */
function mark(html: string, ctx: RenderContext, path: string): string {
	if (!isAsserted(ctx, path)) return html;
	return `<span class="asserted">${html}<span class="chip">ASSERTED</span></span>`;
}

// ── Small deterministic formatters ─────────────────────────────────────────

/** Two-digit ordinal. Deterministic and locale-free: no toLocaleString. */
function ord(n: number): string {
	return n < 10 ? `0${n}` : String(n);
}

/**
 * Code split into lines for the numbered gutter.
 *
 * Tabs become four spaces so the gutter and the text share one grid. The cap is
 * the number of rows that fit the content band at the smaller of the two code
 * sizes below; beyond it the block is truncated AND SAYS SO. Silently clipping
 * the tail was the bug this replaced: the panel drew its bottom border and ate
 * three lines of source with nothing on the slide to say it had.
 */
export const CODE_MAX_LINES = 10;

function codeLines(text: string): { lines: string[]; hidden: number } {
	const all = text.replace(/\t/g, "    ").split("\n");
	if (all.length <= CODE_MAX_LINES) return { lines: all, hidden: 0 };
	return { lines: all.slice(0, CODE_MAX_LINES - 1), hidden: all.length - (CODE_MAX_LINES - 1) };
}

// ── Layout bodies ──────────────────────────────────────────────────────────

/**
 * The bullets list.
 *
 * A single bullet is NOT rendered as a one-item list. That is the case the real
 * huddle transcripts actually produce most often (checked against the bake at
 * ~/.8gent/huddles), and a lonely dash with one line beside it is the exact
 * "just a name coming up" complaint. One bullet is a STATEMENT: set larger, in
 * primary text, in a bordered block with the officer's accent carrying the left
 * edge. Two or more is a ruled list with ordinals, which gives the eye a rhythm
 * and a count without any decoration.
 */
function bulletsBody(items: readonly string[], ctx: RenderContext, base: string): string {
	if (items.length === 1) {
		return `<div class="statement">${mark(esc(items[0] as string), ctx, `${base}.0`)}</div>`;
	}

	const rows = items
		.map(
			(b, i) =>
				`<li><span class="row-n">${ord(i + 1)}</span><span class="row-t">${mark(esc(b), ctx, `${base}.${i}`)}</span></li>`,
		)
		.join("\n      ");
	return `<ul class="rows n${items.length}">\n      ${rows}\n    </ul>`;
}

function body(spec: SlideSpec, ctx: RenderContext, accent: OfficerAccent): string {
	switch (spec.layout) {
		case "cover":
			// The rule and the ghost mark are the whole body. A cover slide's job
			// is one sentence and an unmistakable owner.
			return `<div class="cover-rule"></div>\n    <div class="ghost" aria-hidden="true">${esc(accent.mark)}</div>`;

		case "close":
			// The officer band already names who is speaking. Repeating it here was
			// the "just a name coming up" complaint in miniature. What a closing
			// slide owes the viewer is a full-width terminal rule: the deliberation
			// has stopped.
			return [
				`<div class="cover-rule wide"></div>`,
				`    <div class="ghost" aria-hidden="true">${esc(accent.mark)}</div>`,
			].join("\n");

		case "bullets": {
			if (!spec.bullets?.length) return "";
			const list = bulletsBody(spec.bullets, ctx, "bullets");
			// One point does not fill a 1920 canvas on its own. The officer's mark,
			// bled off the corner at low opacity, is the same device the cover uses
			// and it turns dead space into ownership.
			return spec.bullets.length === 1
				? `${list}\n    <div class="ghost" aria-hidden="true">${esc(accent.mark)}</div>`
				: list;
		}

		case "metric": {
			if (!spec.metric) return "";
			const side = spec.bullets?.length
				? `<div class="metric-side">${bulletsBody(spec.bullets, ctx, "bullets")}</div>`
				: "";
			return [
				`<div class="metric${side ? " split" : ""}">`,
				`      <div class="metric-main">`,
				`        <div class="metric-label">${esc(spec.metric.label)}</div>`,
				`        <div class="metric-value">${mark(esc(spec.metric.value), ctx, "metric.value")}</div>`,
				`        <div class="metric-bar"></div>`,
				`      </div>`,
				side ? `      ${side}` : "",
				`    </div>`,
			]
				.filter(Boolean)
				.join("\n");
		}

		case "quote": {
			if (!spec.quote) return "";
			const attribution = spec.quote.attribution
				? `\n      <footer class="quote-attr"><span class="attr-rule"></span>${esc(spec.quote.attribution)}</footer>`
				: "";
			return [
				`<blockquote class="quote">`,
				`      <span class="quote-glyph" aria-hidden="true">&ldquo;</span>`,
				`      <p class="quote-text">${mark(esc(spec.quote.text), ctx, "quote.text")}</p>${attribution}`,
				`    </blockquote>`,
			].join("\n");
		}

		case "compare": {
			if (!spec.compare) return "";
			// Genuinely opposed: two panels on different surfaces, carrying
			// different colours from the same composed palette, with their kickers
			// mirrored outward. The divider is a real rule with the pivot on it,
			// not a word floating in a gap.
			return [
				`<div class="compare">`,
				`      <section class="panel side-a">`,
				`        <span class="panel-ghost" aria-hidden="true">A</span>`,
				`        <span class="panel-k">A</span>`,
				`        <p class="panel-t">${mark(esc(spec.compare.left), ctx, "compare.left")}</p>`,
				`      </section>`,
				`      <div class="divider"><span class="pivot">vs</span></div>`,
				`      <section class="panel side-b">`,
				`        <span class="panel-ghost" aria-hidden="true">B</span>`,
				`        <span class="panel-k">B</span>`,
				`        <p class="panel-t">${mark(esc(spec.compare.right), ctx, "compare.right")}</p>`,
				`      </section>`,
				`    </div>`,
			].join("\n");
		}

		case "timeline": {
			if (!spec.timeline?.length) return "";
			// A sequence, drawn as a sequence: one continuous connector through
			// numbered nodes, the last node filled to mark the end of the run.
			const steps = spec.timeline
				.map(
					(t, i, all) =>
						`<li class="${i === all.length - 1 ? "last" : ""}"><span class="node">${i + 1}</span><span class="node-t">${mark(esc(t), ctx, `timeline.${i}`)}</span></li>`,
				)
				.join("\n      ");
			const connector = spec.timeline.length > 1 ? `<span class="connector" aria-hidden="true"></span>\n      ` : "";
			return `<ol class="timeline n${spec.timeline.length}">\n      ${connector}${steps}\n    </ol>`;
		}

		case "code": {
			if (!spec.code) return "";
			const { lines, hidden } = codeLines(spec.code.text);
			const gutter = lines.map((_, i) => `<span>${i + 1}</span>`).join("");
			const text = lines.map((l) => `<span>${esc(l) || "&nbsp;"}</span>`).join("");
			const more = hidden > 0 ? `<span class="more">${hidden} more line${hidden === 1 ? "" : "s"} not shown</span>` : "";
			return [
				`<figure class="codeblock rows${lines.length}">`,
				`      <figcaption class="code-bar"><span class="lang">${esc(spec.code.lang)}</span>${more}</figcaption>`,
				`      <pre class="code-body"><span class="gutter" aria-hidden="true">${gutter}</span><code>${text}</code></pre>`,
				`    </figure>`,
			].join("\n");
		}
	}
}

// ── The progress rail ──────────────────────────────────────────────────────

/**
 * Position in the deliberation, as a rail rather than a fraction. During a live
 * huddle the total is not knowable, so the rail GROWS: one tick per turn taken,
 * the current one in the officer's accent. In the bake the total is known and
 * the rail shows the whole deck. Either way you can see the shape of the
 * deliberation without reading a number, which is the point.
 */
function rail(ctx: RenderContext): string {
	const total = ctx.total && ctx.total > 0 ? Math.min(ctx.total, 24) : Math.min(ctx.index, 24);
	const here = Math.min(ctx.index, total);
	const ticks = Array.from({ length: total }, (_, i) => {
		const n = i + 1;
		const cls = n === here ? "tick now" : n < here ? "tick done" : "tick";
		return `<span class="${cls}"></span>`;
	}).join("");
	const counter = ctx.total && ctx.total > 0 ? `${ctx.index} / ${ctx.total}` : String(ctx.index);
	return `<div class="rail" role="img" aria-label="turn ${esc(counter)}">${ticks}</div>`;
}

// ── Stylesheet, composed ───────────────────────────────────────────────────

/**
 * Every number below is read off the theme. The only literals are structural
 * facts about the medium (the 1920x1080 canvas, `position: relative`) and
 * ratios that describe a relationship rather than a size.
 */
function stylesheet(t: SlideTheme, a: OfficerAccent): string {
	const c = t.color;
	const s = t.space;
	const ty = t.type;
	const hairline = alpha(c.textTertiary, 0.22);
	const col = Math.round((CANVAS_W - t.pad.x * 2) / 12);

	/**
	 * WCAG 2.2 SC 1.4.3 floors, applied where the composer cannot see them.
	 *
	 * The `accent` and `text-tertiary` roles are solved to 3:1, which is the
	 * LARGE-text floor, and large text is 24px at normal weight or 18.66px at
	 * bold. A 16px accent label at weight 600 is neither, and would need 4.5:1.
	 * The composer has no way to know what size a consumer will set its roles
	 * at, so the renderer holds the other half of the contract: anything painted
	 * in a 3:1 role is set at 19px or more AND at weight 700, which puts it
	 * inside the large-text definition. Below that floor the role changes, not
	 * the ratio.
	 */
	const LARGE_BOLD_MIN = 19;
	const accentSmall = Math.max(LARGE_BOLD_MIN, Math.round(ty.sub.px * 0.78));
	const accentTiny = Math.max(LARGE_BOLD_MIN, Math.round(ty.sub.px * 0.72));
	const nodeSize = Math.round(ty.lead.px * 2.1);
	const chipRadius = Math.min(t.radius.sm, Math.round(ty.sub.px * 0.32));

	/**
	 * Decoration alphas differ by polarity, and that is not a fudge.
	 *
	 * A translucent colour composites towards the page. On a dark ground the page
	 * is nearly black, so a 9 per cent accent still reads as a tinted shape; on a
	 * light ground the same 9 per cent composites towards white and disappears.
	 * The composer solves the roles that carry contrast; the washes and the ghost
	 * marks carry none, so their weight is the renderer's to set, and it has to be
	 * set per polarity or half the lattice ships slides with no texture at all.
	 * Found by rendering a light design and looking at it, not by reasoning.
	 */
	const light = t.polarity === "light";
	const ghostA = light ? 0.16 : 0.09;
	const washA = light ? 0.16 : 0.3;
	const gridA = light ? 0.16 : 0.09;
	const panelGhostA = light ? 0.18 : 0.11;
	const quoteGlyphA = light ? 0.16 : 0.1;

	const font = (k: keyof SlideTheme["type"]): string => {
		const f = ty[k];
		return `font-size:${f.px}px;line-height:${f.lineHeightPx}px;font-weight:${f.weight};letter-spacing:${f.tracking}em`;
	};

	return `
  /* The composed motion tokens, published as custom properties.
     They are NOT used to animate anything inside the slide, and that is a
     decision rather than an omission: the bake screenshots this document with a
     fixed virtual-time budget, so an animation running inside it is a source of
     pixel nondeterminism, and the provenance rule needs the PNG to be as
     reproducible as the HTML. A huddle's motion belongs BETWEEN slides, where
     the stage owns the transition, so the values are published here for the
     stage to read instead of being hardcoded there.
     The reduced-motion block comes from the token's own declared reduced
     variant, so it can never disagree with it. */
  :root{--motion-enter-duration:${t.motion.enterMs}ms;--motion-enter-easing:${t.motion.easing}}
  @media (prefers-reduced-motion: reduce){
    :root{--motion-enter-duration:${t.motion.reducedMs}ms;--motion-enter-axis:opacity}
  }

  *{margin:0;padding:0;box-sizing:border-box}
  html,body{width:${CANVAS_W}px;height:${CANVAS_H}px;overflow:hidden}
  body{background:${c.bg0};color:${c.text};
    font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display","Helvetica Neue",Helvetica,Arial,sans-serif;
    -webkit-font-smoothing:antialiased;text-rendering:geometricPrecision}

  /* The frame. A 12 column hairline grid at 4 per cent, the composed spacing
     ramp as the margins, and a corner wash in the officer's quiet accent. The
     grid is the design system made visible rather than decoration. */
  .slide{position:relative;width:${CANVAS_W}px;height:${CANVAS_H}px;
    padding:${t.pad.top}px ${t.pad.x}px ${t.pad.bottom}px ${t.pad.x}px;
    display:flex;flex-direction:column;overflow:hidden;
    background:
      radial-gradient(120% 90% at 100% 0%, ${alpha(a.hex, washA)} 0%, ${alpha(a.hex, 0)} 55%),
      linear-gradient(168deg, ${c.bg1} 0%, ${c.bg0} 58%)}
  .grid{position:absolute;left:${t.pad.x}px;right:${t.pad.x}px;top:0;bottom:0;pointer-events:none;
    background-image:repeating-linear-gradient(90deg, ${alpha(c.textTertiary, gridA)} 0 1px, transparent 1px ${col}px)}
  .spine{position:absolute;left:0;top:0;bottom:0;width:${s["2xs"]}px;
    background:linear-gradient(180deg, ${a.hex} 0%, ${alpha(a.hex, 0.32)} 100%)}

  /* Officer band. The chip is the identity signal that survives a video feed:
     colour reinforces it, the mark carries it. */
  .who{display:flex;align-items:center;gap:${s.s}px;flex:none;position:relative}
  .who .chip-mark{flex:none;display:flex;align-items:center;justify-content:center;
    width:${Math.round(ty.sub.px * 2.6)}px;height:${Math.round(ty.sub.px * 2.6)}px;
    border-radius:${Math.min(t.radius.md, Math.round(ty.sub.px * 1.3))}px;
    background:${a.hex};color:${a.onHex};
    font-size:${Math.round(ty.sub.px * 0.95)}px;font-weight:700;letter-spacing:.02em}
  .who .name{${font("sub")};font-weight:600;color:${c.text}}
  .who .who-code{${font("sub")};font-size:${accentSmall}px;color:${c.textSecondary};
    letter-spacing:.16em;font-weight:600}
  .who .band{flex:1;height:1px;background:${hairline}}
  .who .kicker{${font("sub")};font-size:${accentSmall}px;color:${a.hex};
    letter-spacing:.22em;font-weight:700}

  h1{${font("title")};color:${c.text};max-width:${col * 10}px;margin-top:${s.l}px;flex:none}
  .layout-cover h1,.layout-close h1,.slide.one h1{${font("cover")};max-width:${col * 9}px}

  .content{flex:1;min-height:0;display:flex;flex-direction:column;justify-content:center;
    padding:${s.m}px 0;position:relative}
  .layout-cover .content,.layout-close .content{justify-content:flex-start}

  /* cover + close */
  .cover-rule{width:${s["4xl"]}px;height:${s["2xs"]}px;border-radius:${t.radius.sm}px;
    background:linear-gradient(90deg, ${a.hex}, ${alpha(a.hex, 0.35)})}
  .cover-rule.wide{width:100%;height:${s.xs}px}
  .ghost{position:absolute;right:${-Math.round(ty.hero.px * 0.28)}px;bottom:${-Math.round(ty.hero.px * 0.34)}px;
    font-size:${Math.round(ty.hero.px * 2.4)}px;line-height:.78;font-weight:800;letter-spacing:-.04em;
    color:${alpha(a.hex, ghostA)};pointer-events:none;user-select:none}

  /* bullets: one statement, or a ruled list with ordinals */
  .statement{${font("lead")};font-size:${Math.round(ty.lead.px * 1.32)}px;
    line-height:${Math.round(ty.lead.lineHeightPx * 1.3)}px;color:${c.text};font-weight:500;
    max-width:${col * 9}px;padding:${s.m}px 0 ${s.m}px ${s.l}px;
    border-left:${s["3xs"]}px solid ${a.hex}}
  ul.rows{list-style:none;max-width:${col * 11}px}
  ul.rows li{display:grid;grid-template-columns:${Math.round(ty.lead.px * 2.2)}px 1fr;
    align-items:baseline;gap:${s.s}px;
    padding:${s.s}px 0;border-top:1px solid ${hairline}}
  ul.rows li:first-child{border-top:${s["3xs"]}px solid ${a.hex};padding-top:${s.m}px}
  ul.rows.n5 li{padding:${s.xs}px 0}
  ul.rows .row-n{${font("sub")};font-size:${Math.max(LARGE_BOLD_MIN, Math.round(ty.sub.px * 0.86))}px;color:${a.hex};
    font-weight:700;letter-spacing:.12em;font-variant-numeric:tabular-nums}
  ul.rows .row-t{${font("lead")};color:${c.textSecondary}}
  ul.rows.n5 .row-t{font-size:${Math.round(ty.lead.px * 0.88)}px}

  /* metric: one dominant number, context beside it, never under it */
  .metric{display:grid;grid-template-columns:1fr;gap:${s.xl}px;align-items:center}
  .metric.split{grid-template-columns:1.12fr 1fr}
  .metric-label{${font("sub")};font-size:${Math.max(LARGE_BOLD_MIN, Math.round(ty.sub.px * 0.86))}px;color:${a.hex};
    letter-spacing:.2em;font-weight:700;margin-bottom:${s.xs}px}
  .metric-value{font-size:${ty.hero.px}px;line-height:${ty.hero.lineHeightPx}px;
    font-weight:${ty.hero.weight};letter-spacing:${ty.hero.tracking}em;color:${c.text};
    font-variant-numeric:tabular-nums}
  .metric-bar{margin-top:${s.m}px;height:${s["2xs"]}px;border-radius:${t.radius.sm}px;
    background:linear-gradient(90deg, ${a.hex} 0%, ${alpha(a.hex, 0)} 100%)}
  .metric-side ul.rows{max-width:100%}
  .metric-side ul.rows .row-t{font-size:${Math.round(ty.sub.px * 1.12)}px;
    line-height:${Math.round(ty.sub.lineHeightPx * 1.12)}px}
  .metric-side .statement{font-size:${Math.round(ty.sub.px * 1.24)}px;
    line-height:${Math.round(ty.sub.lineHeightPx * 1.2)}px;max-width:100%}

  /* quote */
  .quote{position:relative;padding-left:${s.xl}px;max-width:${col * 10}px;
    border-left:${s["3xs"]}px solid ${a.hex}}
  .quote-glyph{position:absolute;left:${s.s}px;top:${-Math.round(ty.hero.px * 0.62)}px;
    font-size:${Math.round(ty.hero.px * 1.7)}px;line-height:1;font-weight:800;
    color:${alpha(a.hex, quoteGlyphA)};pointer-events:none}
  .quote-text{position:relative;${font("title")};font-size:${Math.round(ty.title.px * 0.92)}px;
    line-height:${Math.round(ty.title.lineHeightPx * 0.95)}px;font-weight:500;color:${c.text}}
  .quote-attr{display:flex;align-items:center;gap:${s.s}px;margin-top:${s.l}px;
    ${font("sub")};color:${c.textSecondary}}
  .attr-rule{display:block;width:${s.xl}px;height:1px;background:${a.hex}}

  /* compare: two opposed panels with a real divider */
  .compare{display:grid;grid-template-columns:1fr ${s.xl}px 1fr;align-items:stretch;
    width:100%;height:100%}
  .panel{position:relative;overflow:hidden;display:flex;flex-direction:column;
    padding:${s.l}px ${s.m}px;border-radius:${t.radius.lg}px}
  .side-a{background:${c.bg1};border-top:${s["3xs"]}px solid ${a.hex}}
  .side-b{background:${c.bg2};border-top:${s["3xs"]}px solid ${c.secondary};text-align:right}
  .panel-ghost{position:absolute;bottom:${-Math.round(ty.hero.px * 0.3)}px;
    font-size:${Math.round(ty.hero.px * 1.5)}px;line-height:.8;font-weight:800;pointer-events:none}
  .side-a .panel-ghost{left:${s.m}px;color:${alpha(a.hex, panelGhostA)}}
  .side-b .panel-ghost{right:${s.m}px;color:${alpha(c.secondary, panelGhostA)}}
  .panel-k{${font("sub")};font-size:${Math.max(LARGE_BOLD_MIN, Math.round(ty.sub.px * 0.86))}px;font-weight:700;
    letter-spacing:.24em;margin-bottom:${s.m}px}
  .side-a .panel-k{color:${a.hex}}
  .side-b .panel-k{color:${c.secondary}}
  .panel-t{position:relative;${font("lead")};color:${c.text}}
  .divider{position:relative;display:flex;align-items:center;justify-content:center}
  .divider::before{content:"";position:absolute;top:0;bottom:0;width:1px;background:${hairline}}
  .pivot{position:relative;display:flex;align-items:center;justify-content:center;
    width:${s.xl}px;height:${s.xl}px;border-radius:${s.xl}px;
    background:${c.bg0};border:1px solid ${c.border};
    ${font("sub")};font-size:${accentTiny}px;color:${c.textSecondary};
    letter-spacing:.08em;font-weight:600}

  /* timeline: nodes on a single continuous connector */
  ol.timeline{list-style:none;position:relative;display:grid;gap:${s.m}px;width:100%}
  ol.timeline.n1{grid-template-columns:repeat(1,1fr)}
  ol.timeline.n2{grid-template-columns:repeat(2,1fr)}
  ol.timeline.n3{grid-template-columns:repeat(3,1fr)}
  ol.timeline.n4{grid-template-columns:repeat(4,1fr)}
  ol.timeline.n5{grid-template-columns:repeat(5,1fr)}
  .connector{position:absolute;left:0;top:${Math.round(nodeSize / 2)}px;height:${s["3xs"]}px;
    background:linear-gradient(90deg, ${a.hex} 0%, ${alpha(a.hex, 0.35)} 100%)}
  ${[2, 3, 4, 5]
		.map((n) => `.timeline.n${n} .connector{right:calc(${(100 / n).toFixed(4)}% - ${Math.round(nodeSize / 2)}px)}`)
		.join("\n  ")}
  ol.timeline li{position:relative;display:flex;flex-direction:column;gap:${s.s}px}
  .node{flex:none;display:flex;align-items:center;justify-content:center;
    width:${nodeSize}px;height:${nodeSize}px;border-radius:${nodeSize}px;
    background:${c.bg0};border:${s["3xs"]}px solid ${a.hex};color:${a.hex};
    ${font("sub")};font-size:${Math.max(LARGE_BOLD_MIN, Math.round(ty.sub.px * 0.95))}px;font-weight:700}
  ol.timeline li.last .node{background:${a.hex};color:${a.onHex}}
  .node-t{${font("lead")};color:${c.textSecondary};padding-right:${s.m}px}
  ol.timeline.n5 .node-t{${font("sub")};font-size:${Math.round(ty.sub.px * 1.08)}px;
    line-height:${Math.round(ty.sub.lineHeightPx * 1.1)}px}

  /* code: a numbered gutter, so it reads as source and not as a paragraph */
  .codeblock{width:100%;border:1px solid ${alpha(c.border, 0.55)};border-radius:${t.radius.lg}px;
    background:${c.bg1};overflow:hidden}
  .code-bar{display:flex;align-items:center;justify-content:space-between;gap:${s.m}px;
    padding:${s.s}px ${s.m}px;border-bottom:1px solid ${alpha(c.border, 0.4)};background:${c.bg2}}
  .code-bar .more{${font("sub")};font-size:${accentTiny}px;color:${c.textSecondary};letter-spacing:.1em}
  .lang{display:inline-block;padding:${s["3xs"]}px ${s.xs}px;border-radius:${chipRadius}px;
    background:${a.hex};color:${a.onHex};line-height:1.4;
    ${font("sub")};font-size:${accentTiny}px;font-weight:700;letter-spacing:.18em}
  .code-body{display:flex;gap:${s.m}px;padding:${s.m}px;
    font-family:"SF Mono",Menlo,Monaco,Consolas,monospace;
    font-size:${Math.round(ty.sub.px * 0.94)}px;line-height:${Math.round(ty.sub.lineHeightPx * 1.05)}px;
    color:${c.text};white-space:pre}
  ${[8, 9, 10]
		.map(
			(n) =>
				`.codeblock.rows${n} .code-body{font-size:${Math.round(ty.sub.px * 0.76)}px;line-height:${Math.round(ty.sub.lineHeightPx * 0.86)}px}`,
		)
		.join("\n  ")}
  .code-body .gutter{display:flex;flex-direction:column;text-align:right;
    padding-right:${s.s}px;border-right:1px solid ${hairline};
    color:${c.textSecondary};font-variant-numeric:tabular-nums}
  .code-body code{display:flex;flex-direction:column;overflow:hidden}

  /* the unverified-value chip. Text, never colour alone. */
  .asserted{display:inline-flex;align-items:baseline;gap:${s.xs}px;flex-wrap:wrap}
  .asserted .chip{font-size:${accentTiny}px;line-height:1.35;font-weight:700;letter-spacing:.14em;
    color:${c.onWarn};background:${c.warn};border-radius:${chipRadius}px;
    padding:${s["3xs"]}px ${s.xs}px;white-space:nowrap;position:relative;top:${-Math.round(ty.sub.px * 0.22)}px}
  .metric-value .chip{top:${-Math.round(ty.hero.px * 0.34)}px;margin-left:${s.s}px}

  /* foot: the deliberation's shape, not a page number */
  .foot{flex:none;display:flex;justify-content:space-between;align-items:center;gap:${s.m}px;
    padding-top:${s.s}px;border-top:1px solid ${hairline};
    ${font("sub")};font-size:${accentTiny}px;color:${c.textSecondary};letter-spacing:.16em}
  .rail{display:flex;align-items:center;gap:${s["3xs"]}px;flex:1;justify-content:center}
  .tick{display:block;width:${s.s}px;height:${s["3xs"]}px;border-radius:${chipRadius}px;
    background:${c.textTertiary}}
  .tick.done{background:${a.hex};opacity:.6}
  .tick.now{background:${a.hex};width:${s.xl}px}
  .count{font-variant-numeric:tabular-nums}
`.trim();
}

// ── The pure entry point ───────────────────────────────────────────────────

export interface RenderedSlide {
	html: string;
	sha256: string;
}

/**
 * Render a validated SlideSpec to standalone HTML plus its content hash.
 *
 * Determinism contract: the ONLY inputs are `spec`, `ctx` and the theme that
 * `ctx.huddleId` composes to. Nothing here reads a clock, a random source, the
 * filesystem, or the network, and design-compose forbids the same by test.
 * See __tests__/slide-render.determinism.test.ts, which renders every layout a
 * hundred times and asserts exactly one distinct hash per layout.
 */
export function renderSlide(spec: SlideSpec, ctx: RenderContext): RenderedSlide {
	const theme = themeFor(ctx.huddleId ?? "");
	const accent = accentFor(theme, ctx.code);
	const counter = ctx.total && ctx.total > 0 ? `${ctx.index} / ${ctx.total}` : String(ctx.index);
	const kicker = accent.role;
	// A slide carrying a single point is composed differently from a list. The
	// variant is derived from the spec, never from a clock or a counter, so it is
	// part of the deterministic render.
	const variant = spec.layout === "bullets" && spec.bullets?.length === 1 ? " one" : "";

	const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:">
<title>${esc(spec.heading)}</title>
<!-- ${esc(theme.summary)} -->
<style>
${stylesheet(theme, accent)}
</style>
</head>
<body>
  <section class="slide layout-${esc(spec.layout)}${variant}" data-design="${esc(theme.designId)}">
    <div class="grid" aria-hidden="true"></div>
    <div class="spine" aria-hidden="true"></div>
    <header class="who">
      <span class="chip-mark" aria-hidden="true">${esc(accent.mark)}</span>
      <span class="name">${esc(ctx.name)}</span>
      <span class="who-code">${esc(ctx.code)}</span>
      <span class="band"></span>
      <span class="kicker">${esc(kicker)}</span>
    </header>
    <h1>${esc(spec.heading)}</h1>
    <div class="content">
    ${body(spec, ctx, accent)}
    </div>
    <div class="foot"><span>8gent huddle</span>${rail(ctx)}<span class="count">${esc(counter)}</span></div>
  </section>
</body>
</html>
`;
	// The hash covers the theme version AND the composed design id, so a template
	// change and a design change are both visible as a hash change rather than a
	// silent redesign.
	const sha256 = createHash("sha256").update(`${THEME_VERSION}\n${theme.designId}\n${html}`).digest("hex");
	return { html, sha256 };
}
