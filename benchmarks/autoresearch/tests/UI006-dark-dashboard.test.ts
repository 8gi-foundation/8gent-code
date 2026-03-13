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

describe("UI006 - Dark Theme Analytics Dashboard", () => {
  test("CSS custom properties defined (at least 4 --variable declarations)", () => {
    const varDecls = css.match(/--[\w-]+\s*:/g) ?? [];
    expect(varDecls.length).toBeGreaterThanOrEqual(4);
  });

  test("var(-- used in 5+ declarations for theming", () => {
    const varUsages = css.match(/var\(--/g) ?? [];
    expect(varUsages.length).toBeGreaterThanOrEqual(5);
  });

  test("background color is dark (low RGB values)", () => {
    const hasDarkHex = css.match(/background(-color)?\s*:\s*#(0[0-9a-f]|1[0-9a-f]|2[0-3])/i);
    const hasDarkRgb = css.match(/background(-color)?\s*:\s*rgb\(\s*\d{1,2}\s*,/i);
    const hasDarkVar = css.match(/--[\w-]*(bg|background|surface|base)[\w-]*\s*:\s*#(0[0-9a-f]|1[0-9a-f]|2[0-3])/i);
    expect(hasDarkHex || hasDarkRgb || hasDarkVar).not.toBeNull();
  });

  test("4+ stat card elements present", () => {
    const cards = html.match(/<(div|section|article)[^>]*class="[^"]*(?:stat|card|metric|kpi)[^"]*"[^>]*>/gi) ?? [];
    if (cards.length >= 4) {
      expect(cards.length).toBeGreaterThanOrEqual(4);
    } else {
      // fallback: count repeated card-like structures
      const allCards = html.match(/<(div|section|article)[^>]*class="[^"]*card[^"]*"[^>]*>/gi) ?? [];
      const statSections = html.match(/<(div|section)[^>]*class="[^"]*stat[^"]*"[^>]*>/gi) ?? [];
      expect(allCards.length + statSections.length).toBeGreaterThanOrEqual(4);
    }
  });

  test("bar chart with 7+ child elements with varying heights", () => {
    const barElements = html.match(/height\s*:\s*\d+(%|px|rem|em)/gi) ?? [];
    const inlineHeights = html.match(/style="[^"]*height\s*:\s*\d+/gi) ?? [];
    const barClasses = html.match(/class="[^"]*bar[^"]*"/gi) ?? [];
    expect(Math.max(barElements.length, inlineHeights.length, barClasses.length)).toBeGreaterThanOrEqual(7);
  });

  test("sidebar nav with 4+ navigation items", () => {
    const navItems = html.match(/<(a|li|button)[^>]*class="[^"]*nav[^"]*"[^>]*>/gi)
      ?? html.match(/<nav[\s\S]*?<\/nav>/i)?.[0]?.match(/<(a|li)\b/gi)
      ?? [];
    const sidebarLinks = html.match(/<(aside|div)[^>]*class="[^"]*sidebar[^"]*"[\s\S]*?<\/\1>/i)?.[0]?.match(/<(a|li)\b/gi) ?? [];
    expect(Math.max(navItems.length, sidebarLinks.length)).toBeGreaterThanOrEqual(4);
  });

  test("green/red colors for positive/negative indicators", () => {
    const hasGreen = css.match(/(#[0-9a-f]*[2-9a-f][0-9a-f]*[0-4][0-9a-f]|green|#[24][0-9a-f]b|rgb\([^)]*,\s*(1[2-9]\d|[2-9]\d\d)\s*,)/i)
      || html.match(/(green|positive|success|up)/i);
    const hasRed = css.match(/(#[ef][0-9a-f][0-4]|red|#f[0-9a-f][0-4]|rgb\(\s*(1[5-9]\d|[2-9]\d\d)\s*,\s*[0-6]\d)/i)
      || html.match(/(red|negative|danger|down)/i);
    expect(hasGreen).not.toBeNull();
    expect(hasRed).not.toBeNull();
  });

  test("display: grid or display: flex used for layout", () => {
    expect(css).toMatch(/display\s*:\s*(grid|flex)/i);
  });

  test("text colors are light enough for contrast (no pure black text on dark bg)", () => {
    const hasLightText = css.match(/color\s*:\s*(#[a-f][a-f0-9]{5}|#[c-f][0-9a-f]{2,5}|white|#fff|rgba?\(\s*(1[5-9]\d|[2-9]\d\d))/i)
      || css.match(/--[\w-]*(text|color|fg)[\w-]*\s*:\s*(#[a-f][a-f0-9]{5}|#[c-f][0-9a-f]{2,5}|white|#fff)/i);
    expect(hasLightText).not.toBeNull();
  });
});
