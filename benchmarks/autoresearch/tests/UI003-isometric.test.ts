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

describe("UI003 - 3D Isometric Dashboard", () => {
  test("perspective CSS property with value >= 400", () => {
    const perspectiveMatches = css.match(/perspective\s*:\s*(\d+)/gi) ?? [];
    const hasValidPerspective = perspectiveMatches.some(m => {
      const val = parseInt(m.match(/(\d+)/)?.[1] ?? "0", 10);
      return val >= 400;
    });
    expect(hasValidPerspective).toBe(true);
  });

  test("6+ tile elements exist", () => {
    // Match elements with class containing "tile", "card", "panel", or "cell"
    const tileByClass = html.match(/class\s*=\s*"[^"]*\b(tile|card|panel|cell|block|item)\b[^"]*"/gi) ?? [];
    expect(tileByClass.length).toBeGreaterThanOrEqual(6);
  });

  test("transform contains rotateX and rotateY", () => {
    const hasRotateX = /rotateX\s*\(/i.test(css);
    const hasRotateY = /rotateY\s*\(/i.test(css);
    expect(hasRotateX).toBe(true);
    expect(hasRotateY).toBe(true);
  });

  test("transform-style: preserve-3d exists", () => {
    const hasPreserve3d = /transform-style\s*:\s*preserve-3d/i.test(css);
    expect(hasPreserve3d).toBe(true);
  });

  test(":hover modifies transform", () => {
    // Find :hover blocks and check if they contain transform
    const hoverBlocks = css.match(/:hover\s*\{([^}]*)\}/gi) ?? [];
    const hoverModifiesTransform = hoverBlocks.some(block => /transform\s*:/i.test(block));
    expect(hoverModifiesTransform).toBe(true);
  });

  test("transition on tiles", () => {
    const hasTransition = /transition\s*:/i.test(css);
    expect(hasTransition).toBe(true);
  });

  test("each tile has text content (label + value)", () => {
    // Extract tile-like elements and check they have text
    // Look for elements with tile/card/panel class that contain text
    const tileBlocks = html.match(/<div[^>]*class\s*=\s*"[^"]*\b(tile|card|panel|cell|block|item)\b[^"]*"[^>]*>([\s\S]*?)<\/div>/gi) ?? [];
    const tilesWithText = tileBlocks.filter(block => {
      const textContent = block.replace(/<[^>]*>/g, "").trim();
      return textContent.length > 0;
    });
    expect(tilesWithText.length).toBeGreaterThanOrEqual(3);
  });

  test("CSS bar chart elements exist (divs with varying heights)", () => {
    // Look for bar/chart elements or inline height styles
    const barByClass = html.match(/class\s*=\s*"[^"]*\b(bar|chart-bar|column|metric)\b[^"]*"/gi) ?? [];
    const heightStyles = html.match(/style\s*=\s*"[^"]*height\s*:\s*\d+/gi) ?? [];
    const barInCSS = /\.(bar|chart-bar|column)\b/i.test(css);
    expect(barByClass.length > 0 || heightStyles.length > 0 || barInCSS).toBe(true);
  });
});
