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

describe("UI001 - Neumorphic Button Set", () => {
  test("at least 4 button elements exist", () => {
    const buttons = html.match(/<button[\s>]/gi) ?? [];
    expect(buttons.length).toBeGreaterThanOrEqual(4);
  });

  test("box-shadow has two shadow layers (comma-separated)", () => {
    // Match box-shadow declarations that contain a comma (two layers)
    const boxShadowDecls = css.match(/box-shadow\s*:\s*([^;]+)/gi) ?? [];
    const hasDoubleLayer = boxShadowDecls.some(decl => {
      const value = decl.replace(/box-shadow\s*:\s*/i, "");
      // Split by commas not inside parentheses
      const layers = value.split(/,(?![^(]*\))/);
      return layers.length >= 2;
    });
    expect(hasDoubleLayer).toBe(true);
  });

  test("at least one box-shadow uses inset keyword", () => {
    const insetShadow = /box-shadow\s*:[^;]*\binset\b/i.test(css);
    expect(insetShadow).toBe(true);
  });

  test("border-radius >= 10px on buttons", () => {
    const radiusMatches = css.match(/border-radius\s*:\s*(\d+)/gi) ?? [];
    const hasLargeRadius = radiusMatches.some(m => {
      const val = parseInt(m.match(/(\d+)/)?.[1] ?? "0", 10);
      return val >= 10;
    });
    expect(hasLargeRadius).toBe(true);
  });

  test("transition property is present", () => {
    const hasTransition = /transition\s*:/i.test(css);
    expect(hasTransition).toBe(true);
  });

  test(":hover pseudo-class rule exists", () => {
    const hasHover = /:hover\s*\{/i.test(css);
    expect(hasHover).toBe(true);
  });

  test(":active or .pressed rule exists", () => {
    const hasActive = /:active\s*\{/i.test(css);
    const hasPressed = /\.pressed\s*\{/i.test(css);
    expect(hasActive || hasPressed).toBe(true);
  });

  test("disabled state has opacity or reduced shadow", () => {
    // Check for :disabled or .disabled rule
    const disabledBlock = css.match(/(:disabled|\.disabled)\s*\{([^}]*)\}/i);
    expect(disabledBlock).not.toBeNull();
    const block = disabledBlock?.[2] ?? "";
    const hasOpacity = /opacity\s*:/i.test(block);
    const hasShadow = /box-shadow\s*:/i.test(block);
    expect(hasOpacity || hasShadow).toBe(true);
  });
});
