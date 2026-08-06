/**
 * 8gent Huddle Phase 1 - the deterministic slide renderer (spec section 4.6).
 *
 *   render(spec, ctx) -> { html, sha256 }
 *
 * PURE. No Date.now(), no Math.random(), no locale-dependent formatting, no
 * network, no filesystem read. Same spec plus same theme version yields
 * byte-identical HTML, therefore an identical sha256. The hash is stamped into
 * the manifest and the transcript, so anyone can re-derive a huddle's visuals
 * and confirm they match. That is the 2026-08-03 provenance rule applied to
 * pixels.
 *
 * SECURITY (spec 4.3): every officer-supplied string is HTML-escaped HERE, in
 * the renderer, not in the parser - so a spec that reaches this function by any
 * path is escaped. Templates are TypeScript template literals. There is no
 * template language, no eval, no Function, no dynamic import, and no
 * spec-driven filesystem read. The worst a fully adversarial officer achieves
 * is an ugly slide.
 *
 * BRAND (BRAND.md): warm palette only. Primary orange #E8610A, dark variant
 * #F07A28, warm near-black grounds. Banned hues 270-350 appear nowhere. No em
 * dashes are emitted by any template in this file.
 *
 * HONESTY (the constraint that matters most): a value the system did not
 * verify is NOT stated flatly. `assertedFields` carries the set of field paths
 * whose claim reference failed to resolve, and every one of them renders with a
 * visible ASSERTED chip. An unverified number never looks like a verified one.
 */

import { createHash } from "node:crypto";
import type { SlideSpec } from "./slide-spec";

/** Bump when any template or token below changes. Part of the hash input, so a
 *  theme change is visible as a hash change rather than a silent redesign. */
export const THEME_VERSION = "huddle-warm-1";

export const PALETTE = {
	bg0: "#0A0908",
	bg1: "#12100E",
	bg2: "#1C1A17",
	bg3: "#252220",
	border: "#2E2A26",
	text: "#FAF7F4",
	textSecondary: "#C8C2BA",
	textTertiary: "#8A8078",
	accent: "#F07A28",
	accentDeep: "#E8610A",
	/** Warm amber for the ASSERTED chip. Deliberately NOT red: an asserted
	 *  value is unverified, not wrong, and the visual language should say so. */
	warn: "#D8A02A",
} as const;

/** Everything the renderer needs beyond the spec itself. All of it declared,
 *  none of it inferred, none of it sampled from a clock. */
export interface RenderContext {
	/** Officer code, e.g. "8TO", or "HUMAN" for a James turn. */
	code: string;
	/** Display name, e.g. "Rishi" or "James". */
	name: string;
	/** 1-based position in the deck, for the corner marker. */
	index: number;
	/** Total slides, when known at render time. 0 renders the index alone. */
	total?: number;
	/**
	 * Dotted paths of fields carrying a value the verifier could NOT confirm
	 * (e.g. "metric.value", "bullets.1"). Each renders an ASSERTED chip.
	 */
	assertedFields?: readonly string[];
}

// ── Escaping (spec 4.3 layer 2) ────────────────────────────────────────────

/** Same discipline as hypervideo.py::_esc. Applied to EVERY interpolation. */
export function esc(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
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

// ── Layout templates ───────────────────────────────────────────────────────

function bulletsHtml(items: readonly string[], ctx: RenderContext, base: string): string {
	return items
		.map((b, i) => `<li>${mark(esc(b), ctx, `${base}.${i}`)}</li>`)
		.join("\n      ");
}

function body(spec: SlideSpec, ctx: RenderContext): string {
	switch (spec.layout) {
		case "cover":
			return `<div class="cover-rule"></div>`;

		case "close":
			return `<div class="close-mark">${esc(ctx.name)}</div>`;

		case "bullets":
			return spec.bullets?.length ? `<ul class="bullets">\n      ${bulletsHtml(spec.bullets, ctx, "bullets")}\n    </ul>` : "";

		case "metric": {
			if (!spec.metric) return "";
			return [
				`<div class="metric">`,
				`      <div class="metric-value">${mark(esc(spec.metric.value), ctx, "metric.value")}</div>`,
				`      <div class="metric-label">${esc(spec.metric.label)}</div>`,
				`    </div>`,
				spec.bullets?.length ? `<ul class="bullets sub">\n      ${bulletsHtml(spec.bullets, ctx, "bullets")}\n    </ul>` : "",
			]
				.filter(Boolean)
				.join("\n    ");
		}

		case "quote": {
			if (!spec.quote) return "";
			const attribution = spec.quote.attribution
				? `\n      <div class="quote-attr">${esc(spec.quote.attribution)}</div>`
				: "";
			return `<blockquote class="quote">\n      <div class="quote-text">${mark(esc(spec.quote.text), ctx, "quote.text")}</div>${attribution}\n    </blockquote>`;
		}

		case "compare": {
			if (!spec.compare) return "";
			return [
				`<div class="compare">`,
				`      <div class="compare-side"><span class="compare-k">A</span>${mark(esc(spec.compare.left), ctx, "compare.left")}</div>`,
				`      <div class="compare-vs">vs</div>`,
				`      <div class="compare-side"><span class="compare-k">B</span>${mark(esc(spec.compare.right), ctx, "compare.right")}</div>`,
				`    </div>`,
			].join("\n");
		}

		case "timeline": {
			if (!spec.timeline) return "";
			const steps = spec.timeline
				.map(
					(t, i) =>
						`<li><span class="step-n">${i + 1}</span><span class="step-t">${mark(esc(t), ctx, `timeline.${i}`)}</span></li>`,
				)
				.join("\n      ");
			return `<ol class="timeline">\n      ${steps}\n    </ol>`;
		}

		case "code": {
			if (!spec.code) return "";
			return `<pre class="code" data-lang="${esc(spec.code.lang)}"><code>${esc(spec.code.text)}</code></pre>`;
		}
	}
}

// ── Stylesheet (compiled in, part of the hash) ─────────────────────────────

const STYLE = `
  *{margin:0;padding:0;box-sizing:border-box}
  html,body{width:1920px;height:1080px;overflow:hidden}
  body{background:${PALETTE.bg0};color:${PALETTE.text};
    font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display","Helvetica Neue",Helvetica,Arial,sans-serif;
    -webkit-font-smoothing:antialiased}
  .slide{position:relative;width:1920px;height:1080px;padding:112px 128px 96px;
    display:flex;flex-direction:column;
    background:linear-gradient(155deg,${PALETTE.bg1} 0%,${PALETTE.bg0} 62%)}
  .slide::before{content:"";position:absolute;left:0;top:0;width:100%;height:6px;
    background:linear-gradient(90deg,${PALETTE.accentDeep},${PALETTE.accent})}
  .who{display:flex;align-items:center;gap:18px;margin-bottom:44px}
  .who .dot{width:14px;height:14px;border-radius:50%;background:${PALETTE.accent}}
  .who .name{font-size:30px;font-weight:600;letter-spacing:.01em}
  .who .code{font-size:24px;color:${PALETTE.textTertiary};letter-spacing:.16em;font-weight:500}
  h1{font-size:82px;line-height:1.06;font-weight:700;letter-spacing:-.02em;max-width:1500px}
  .layout-cover h1{font-size:104px}
  .layout-close h1{font-size:96px}
  .content{flex:1;display:flex;flex-direction:column;justify-content:center;padding-top:24px}
  .cover-rule{width:220px;height:8px;border-radius:4px;margin-top:56px;
    background:linear-gradient(90deg,${PALETTE.accentDeep},${PALETTE.accent})}
  .close-mark{margin-top:52px;font-size:34px;color:${PALETTE.textSecondary};letter-spacing:.04em}
  ul.bullets,ol.timeline{list-style:none}
  ul.bullets li{font-size:44px;line-height:1.42;color:${PALETTE.textSecondary};
    padding-left:52px;position:relative;margin-bottom:30px}
  ul.bullets li::before{content:"";position:absolute;left:0;top:22px;width:22px;height:4px;
    border-radius:2px;background:${PALETTE.accent}}
  ul.bullets.sub li{font-size:34px;margin-bottom:20px}
  ul.bullets.sub li::before{top:17px;width:16px}
  .metric{margin:16px 0 40px}
  .metric-value{font-size:230px;line-height:.94;font-weight:800;letter-spacing:-.045em;color:${PALETTE.accent}}
  .metric-label{font-size:40px;color:${PALETTE.textSecondary};margin-top:22px;letter-spacing:.01em}
  .quote{border-left:8px solid ${PALETTE.accent};padding-left:56px}
  .quote-text{font-size:60px;line-height:1.34;font-weight:500}
  .quote-attr{font-size:32px;color:${PALETTE.textTertiary};margin-top:32px}
  .compare{display:flex;align-items:stretch;gap:40px;margin-top:24px}
  .compare-side{flex:1;background:${PALETTE.bg2};border:2px solid ${PALETTE.border};border-radius:22px;
    padding:52px 44px;font-size:42px;line-height:1.34;color:${PALETTE.text}}
  .compare-k{display:block;font-size:22px;letter-spacing:.2em;color:${PALETTE.accent};margin-bottom:22px;font-weight:600}
  .compare-vs{align-self:center;font-size:30px;color:${PALETTE.textTertiary};letter-spacing:.1em}
  ol.timeline li{display:flex;align-items:center;gap:32px;margin-bottom:30px}
  .step-n{flex:none;width:62px;height:62px;border-radius:50%;background:${PALETTE.bg2};
    border:2px solid ${PALETTE.accent};color:${PALETTE.accent};
    display:flex;align-items:center;justify-content:center;font-size:28px;font-weight:700}
  .step-t{font-size:40px;color:${PALETTE.textSecondary}}
  pre.code{background:${PALETTE.bg2};border:2px solid ${PALETTE.border};border-radius:20px;
    padding:44px 48px;font-size:32px;line-height:1.6;overflow:hidden;
    font-family:"SF Mono",Menlo,Monaco,Consolas,monospace;color:${PALETTE.text};white-space:pre-wrap}
  pre.code::before{content:attr(data-lang);display:block;font-size:20px;letter-spacing:.18em;
    color:${PALETTE.textTertiary};margin-bottom:24px}
  .asserted{display:inline-flex;align-items:baseline;gap:14px;flex-wrap:wrap}
  .asserted .chip{font-size:20px;font-weight:700;letter-spacing:.14em;color:${PALETTE.bg0};
    background:${PALETTE.warn};border-radius:6px;padding:5px 11px;white-space:nowrap;
    position:relative;top:-6px}
  .metric-value .chip{font-size:26px;top:-70px}
  .foot{display:flex;justify-content:space-between;align-items:flex-end;
    font-size:22px;color:${PALETTE.textTertiary};letter-spacing:.06em}
`.trim();

// ── The pure entry point ───────────────────────────────────────────────────

export interface RenderedSlide {
	html: string;
	sha256: string;
}

/**
 * Render a validated SlideSpec to standalone HTML plus its content hash.
 *
 * Determinism contract: the ONLY inputs are `spec`, `ctx` and the compiled-in
 * theme. Nothing here reads a clock, a random source, the filesystem, or the
 * network. Test: __tests__/slide-render.determinism.test.ts renders every
 * layout 100 times and asserts exactly one distinct hash per layout.
 */
export function renderSlide(spec: SlideSpec, ctx: RenderContext): RenderedSlide {
	const counter = ctx.total && ctx.total > 0 ? `${ctx.index} / ${ctx.total}` : String(ctx.index);
	const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:">
<title>${esc(spec.heading)}</title>
<style>
${STYLE}
</style>
</head>
<body>
  <section class="slide layout-${esc(spec.layout)}">
    <div class="who"><span class="dot"></span><span class="name">${esc(ctx.name)}</span><span class="code">${esc(ctx.code)}</span></div>
    <h1>${esc(spec.heading)}</h1>
    <div class="content">
    ${body(spec, ctx)}
    </div>
    <div class="foot"><span>8gent huddle</span><span>${esc(counter)}</span></div>
  </section>
</body>
</html>
`;
	// The hash covers the theme version explicitly, so a template change is
	// never mistaken for the same slide rendered twice.
	const sha256 = createHash("sha256").update(`${THEME_VERSION}\n${html}`).digest("hex");
	return { html, sha256 };
}
