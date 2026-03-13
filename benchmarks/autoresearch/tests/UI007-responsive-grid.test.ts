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

describe("UI007 - Responsive Magazine Layout", () => {
  test("grid-template-areas with named area strings", () => {
    expect(css).toMatch(/grid-template-areas\s*:/i);
    expect(css).toMatch(/grid-template-areas\s*:\s*["']/i);
  });

  test("3+ @media blocks with different breakpoints", () => {
    const mediaBlocks = css.match(/@media\s*\([^)]*\)/g) ?? [];
    const uniqueBreakpoints = new Set(mediaBlocks.map(m => m.replace(/\s+/g, "")));
    expect(uniqueBreakpoints.size).toBeGreaterThanOrEqual(3);
  });

  test("grid-template-columns changes across breakpoints", () => {
    const columnsDecls = css.match(/grid-template-columns\s*:/gi) ?? [];
    expect(columnsDecls.length).toBeGreaterThanOrEqual(2);
  });

  test("hero element spans multiple columns", () => {
    const hasSpan = css.match(/grid-column\s*:\s*(span\s+[2-9]|\d+\s*\/\s*(-1|\d+))/i);
    const hasAreaSpan = css.match(/grid-area\s*:\s*hero/i);
    expect(hasSpan || hasAreaSpan).not.toBeNull();
  });

  test("-webkit-line-clamp for text truncation", () => {
    expect(css).toMatch(/-webkit-line-clamp\s*:\s*\d+/i);
  });

  test("aspect-ratio property present", () => {
    expect(css).toMatch(/aspect-ratio\s*:/i);
  });

  test("5+ article/card elements in the layout", () => {
    const articles = html.match(/<article\b/gi) ?? [];
    const cards = html.match(/class="[^"]*card[^"]*"/gi) ?? [];
    const items = html.match(/class="[^"]*item[^"]*"/gi) ?? [];
    expect(Math.max(articles.length, cards.length, articles.length + items.length)).toBeGreaterThanOrEqual(5);
  });

  test("gap property on grid container", () => {
    expect(css).toMatch(/gap\s*:/i);
  });

  test("1fr unit used in grid definitions", () => {
    expect(css).toMatch(/\d*\s*fr\b/i);
  });

  test("gradient overlay with linear-gradient including transparent", () => {
    const gradientWithTransparent = css.match(/linear-gradient\s*\([^)]*transparent/i)
      || css.match(/linear-gradient\s*\([^)]*rgba\s*\([^)]*,\s*0\s*\)/i);
    expect(gradientWithTransparent).not.toBeNull();
  });
});
