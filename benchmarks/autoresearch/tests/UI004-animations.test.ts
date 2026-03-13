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

describe("UI004 - CSS Animation Showcase", () => {
  test("5+ distinct @keyframes blocks", () => {
    const keyframesNames = css.match(/@keyframes\s+[\w-]+/gi) ?? [];
    const uniqueNames = new Set(keyframesNames.map(k => k.toLowerCase()));
    expect(uniqueNames.size).toBeGreaterThanOrEqual(5);
  });

  test("each @keyframes has from/to or percentage stops", () => {
    const keyframeBlocks = css.match(/@keyframes\s+[\w-]+\s*\{[\s\S]*?\}\s*\}/gi) ?? [];
    expect(keyframeBlocks.length).toBeGreaterThanOrEqual(1);
    const allValid = keyframeBlocks.every(block => {
      const hasFromTo = /\b(from|to)\s*\{/i.test(block);
      const hasPercent = /\d+%\s*\{/i.test(block);
      return hasFromTo || hasPercent;
    });
    expect(allValid).toBe(true);
  });

  test("at least one cubic-bezier() value", () => {
    const hasCubicBezier = /cubic-bezier\s*\(/i.test(css);
    expect(hasCubicBezier).toBe(true);
  });

  test("staggered animation-delay (3+ different values)", () => {
    const delayMatches = css.match(/animation-delay\s*:\s*([^;]+)/gi) ?? [];
    // Also check shorthand animation property for delay values
    const animationMatches = css.match(/animation\s*:\s*([^;]+)/gi) ?? [];

    const delayValues = new Set<string>();
    for (const m of delayMatches) {
      const val = m.replace(/animation-delay\s*:\s*/i, "").trim();
      delayValues.add(val);
    }
    // Extract delay-like values (e.g., 0.2s, 0.4s, 0.6s) from shorthand
    const timeValues = css.match(/(\d+\.?\d*m?s)/g) ?? [];
    // We mainly care that animation-delay is used with different values
    // or that the shorthand animation has different timing
    expect(delayValues.size >= 3 || delayMatches.length >= 3 || animationMatches.length >= 3).toBe(true);
  });

  test("animation-iteration-count: infinite on 2+ animations", () => {
    const infiniteInProperty = css.match(/animation-iteration-count\s*:\s*infinite/gi) ?? [];
    // Also check shorthand — "infinite" keyword in animation shorthand
    const infiniteInShorthand = css.match(/animation\s*:[^;]*\binfinite\b/gi) ?? [];
    const total = infiniteInProperty.length + infiniteInShorthand.length;
    expect(total).toBeGreaterThanOrEqual(2);
  });

  test("spinner uses rotate(360deg)", () => {
    const hasRotate360 = /rotate\(\s*360deg\s*\)/i.test(css);
    expect(hasRotate360).toBe(true);
  });

  test("pulse uses scale() and opacity", () => {
    // Find a keyframes block named pulse or similar
    const pulseBlock = css.match(/@keyframes\s+[\w-]*pulse[\w-]*\s*\{[\s\S]*?\}\s*\}/i)?.[0] ?? "";
    // If no explicit pulse block, check globally for scale + opacity in any keyframes
    const allKeyframes = css.match(/@keyframes\s+[\w-]+\s*\{[\s\S]*?\}\s*\}/gi) ?? [];

    let hasScaleAndOpacity = false;
    if (pulseBlock) {
      hasScaleAndOpacity = /scale\s*\(/i.test(pulseBlock) && /opacity\s*:/i.test(pulseBlock);
    }
    if (!hasScaleAndOpacity) {
      // Check if any keyframe block has both scale and opacity
      hasScaleAndOpacity = allKeyframes.some(
        block => /scale\s*\(/i.test(block) && /opacity\s*:/i.test(block)
      );
    }
    expect(hasScaleAndOpacity).toBe(true);
  });

  test("slide uses translateX", () => {
    const allKeyframes = css.match(/@keyframes\s+[\w-]+\s*\{[\s\S]*?\}\s*\}/gi) ?? [];
    const hasTranslateX = allKeyframes.some(block => /translateX\s*\(/i.test(block));
    // Also check if translateX is used in any animation-related transform
    const globalTranslateX = /translateX\s*\(/i.test(css);
    expect(hasTranslateX || globalTranslateX).toBe(true);
  });
});
