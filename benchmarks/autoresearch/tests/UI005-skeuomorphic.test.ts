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

describe("UI005 - Skeuomorphic Toggle Switch & Rotary Knob", () => {
  test("uses checkbox hack with <input type=\"checkbox\"> (no JS toggle)", () => {
    expect(html).toMatch(/<input[^>]*type=["']checkbox["'][^>]*>/i);
  });

  test("radial-gradient used on knob element for 3D appearance", () => {
    expect(css).toMatch(/radial-gradient/i);
  });

  test("inset box-shadow on track for recessed look", () => {
    expect(css).toMatch(/box-shadow:[^;]*inset/i);
  });

  test("transition property for smooth state change animation", () => {
    expect(css).toMatch(/transition\s*:/i);
  });

  test(":checked selector present that changes transform or position", () => {
    const checkedBlock = css.match(/:checked[^{]*\{([^}]*)\}/g);
    expect(checkedBlock).not.toBeNull();
    const combined = checkedBlock!.join(" ");
    expect(combined).toMatch(/transform|left|translate/i);
  });

  test("::before or ::after pseudo-elements used for decorative layers", () => {
    expect(css).toMatch(/::?(before|after)/i);
  });

  test("border-radius: 50% for circular knob/toggle thumb", () => {
    expect(css).toMatch(/border-radius\s*:\s*50%/i);
  });

  test("repeating-linear-gradient for brushed metal texture", () => {
    expect(css).toMatch(/repeating-linear-gradient/i);
  });

  test("multiple box-shadow layers (3+) for depth on at least one element", () => {
    const shadowDecls = css.match(/box-shadow\s*:[^;]+/gi) ?? [];
    const hasMultiLayer = shadowDecls.some(decl => {
      const commas = decl.split(",").length - 1;
      return commas >= 2; // 3+ layers = 2+ commas
    });
    expect(hasMultiLayer).toBe(true);
  });
});
