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

describe("UI002 - Glassmorphism Card Layout", () => {
  test("3+ card elements exist", () => {
    // Match divs with class containing "card" or article/section elements used as cards
    const cardByClass = html.match(/class\s*=\s*"[^"]*card[^"]*"/gi) ?? [];
    const cardElements = html.match(/<(article|section)[\s>]/gi) ?? [];
    const total = cardByClass.length + cardElements.length;
    expect(total).toBeGreaterThanOrEqual(3);
  });

  test("backdrop-filter contains blur() with value >= 10", () => {
    const blurMatches = css.match(/backdrop-filter\s*:[^;]*blur\(\s*(\d+)/gi) ?? [];
    const hasValidBlur = blurMatches.some(m => {
      const val = parseInt(m.match(/blur\(\s*(\d+)/i)?.[1] ?? "0", 10);
      return val >= 10;
    });
    expect(hasValidBlur).toBe(true);
  });

  test("background uses rgba with alpha <= 0.5", () => {
    const rgbaMatches = css.match(/rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*([\d.]+)\s*\)/gi) ?? [];
    const hasTransparentBg = rgbaMatches.some(m => {
      const alpha = parseFloat(m.match(/,\s*([\d.]+)\s*\)$/)?.[1] ?? "1");
      return alpha <= 0.5;
    });
    expect(hasTransparentBg).toBe(true);
  });

  test("border with rgba white value present", () => {
    // Look for border using rgba with white-ish values (high R, G, B)
    const hasBorderRgba = /border\s*:[^;]*rgba\(\s*2[0-5]\d\s*,\s*2[0-5]\d\s*,\s*2[0-5]\d/i.test(css);
    // Also accept shorthand with white-ish colors
    const hasBorderWhite = /border[^:]*:\s*\d+px\s+solid\s+rgba\(/i.test(css);
    expect(hasBorderRgba || hasBorderWhite).toBe(true);
  });

  test("background gradient exists", () => {
    const hasLinear = /linear-gradient\s*\(/i.test(css);
    const hasRadial = /radial-gradient\s*\(/i.test(css);
    expect(hasLinear || hasRadial).toBe(true);
  });

  test("border-radius >= 8px", () => {
    const radiusMatches = css.match(/border-radius\s*:\s*(\d+)/gi) ?? [];
    const hasRadius = radiusMatches.some(m => {
      const val = parseInt(m.match(/(\d+)/)?.[1] ?? "0", 10);
      return val >= 8;
    });
    expect(hasRadius).toBe(true);
  });

  test("z-index or positioning for overlap", () => {
    const hasZIndex = /z-index\s*:/i.test(css);
    const hasPositioning = /position\s*:\s*(absolute|relative|fixed)/i.test(css);
    expect(hasZIndex || hasPositioning).toBe(true);
  });
});
