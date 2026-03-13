import { describe, test, expect } from "bun:test";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

function loadHTML(): string {
  const dir = process.env.WORK_DIR ?? process.env.FIXTURE_PATH ?? "";
  const htmlPath = join(dir, "index.html");
  if (existsSync(htmlPath)) return readFileSync(htmlPath, "utf-8");
  const fixturePath = join(dir, "fixture.ts");
  if (existsSync(fixturePath)) {
    const content = readFileSync(fixturePath, "utf-8");
    const match = content.match(/export\s+default\s+`([\s\S]*)`/) || content.match(/`([\s\S]*)`/);
    return match?.[1] ?? content;
  }
  return "";
}

const html = loadHTML();
const css = (() => {
  const styleMatches = html.match(/<style[^>]*>([\s\S]*?)<\/style>/gi) ?? [];
  return styleMatches.map(s => s.replace(/<\/?style[^>]*>/gi, "")).join("\n");
})();

describe("UI008 - Interactive Pricing Cards with Tilt", () => {
  test("3 pricing card elements present", () => {
    const cards = html.match(/<(div|section|article)[^>]*class="[^"]*(?:card|pricing|plan|tier)[^"]*"[^>]*>/gi) ?? [];
    expect(cards.length).toBeGreaterThanOrEqual(3);
  });

  test("featured card has elevation/scale difference", () => {
    const hasScale = css.match(/transform\s*:[^;]*scale\s*\(\s*1\.[0-9]/i);
    const hasElevation = css.match(/(featured|popular|highlight|recommended)[^{]*\{[^}]*box-shadow/i)
      || css.match(/box-shadow[^;]*(0\s+\d{2,}px|0\s+\d+px\s+\d{2,}px)/i);
    expect(hasScale || hasElevation).not.toBeNull();
  });

  test("\"Most Popular\" or \"Popular\" badge text present", () => {
    expect(html).toMatch(/(?:most\s+)?popular/i);
  });

  test("each card has 6+ feature list items", () => {
    const listItems = html.match(/<li\b/gi) ?? [];
    // 3 cards * 6 items = 18 minimum
    expect(listItems.length).toBeGreaterThanOrEqual(18);
  });

  test("price text with numeric value present", () => {
    const pricePattern = html.match(/[\$\u00A3\u20AC]\s*\d+|\d+\s*[\$\u00A3\u20AC]|\d+\.\d{2}/);
    expect(pricePattern).not.toBeNull();
  });

  test("CTA button element per card (3+ buttons)", () => {
    const buttons = html.match(/<(button|a)[^>]*class="[^"]*(?:btn|button|cta)[^"]*"[^>]*>/gi)
      ?? html.match(/<button\b/gi)
      ?? [];
    expect(buttons.length).toBeGreaterThanOrEqual(3);
  });

  test("perspective property on container for 3D tilt", () => {
    expect(css).toMatch(/perspective\s*:/i);
  });

  test(":hover uses transform with rotation for tilt effect", () => {
    const hoverBlocks = css.match(/:hover[^{]*\{[^}]*\}/g) ?? [];
    const hasRotation = hoverBlocks.some(block => /transform[^;]*rotate/i.test(block));
    expect(hasRotation).toBe(true);
  });

  test(":hover changes box-shadow for glow effect", () => {
    const hoverBlocks = css.match(/:hover[^{]*\{[^}]*\}/g) ?? [];
    const hasShadow = hoverBlocks.some(block => /box-shadow/i.test(block));
    expect(hasShadow).toBe(true);
  });

  test("gradient used for featured card border or background", () => {
    const hasGradient = css.match(/linear-gradient|radial-gradient/i);
    expect(hasGradient).not.toBeNull();
  });

  test("transition with duration >= 200ms for smooth interactions", () => {
    const transitions = css.match(/transition[^;]*(\d+(\.\d+)?s|\d+ms)/gi) ?? [];
    const hasAdequateDuration = transitions.some(t => {
      const msMatch = t.match(/(\d+)ms/);
      const sMatch = t.match(/(\d+\.?\d*)s(?!.*ms)/);
      if (msMatch) return parseInt(msMatch[1]) >= 200;
      if (sMatch) return parseFloat(sMatch[1]) >= 0.2;
      return false;
    });
    expect(hasAdequateDuration).toBe(true);
  });

  test("button hover state defined", () => {
    const btnHover = css.match(/(btn|button|cta)[^{]*:hover/i)
      || css.match(/:hover[^{]*(btn|button|cta)/i);
    expect(btnHover).not.toBeNull();
  });
});
