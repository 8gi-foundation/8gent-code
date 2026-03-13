import { describe, it, expect, beforeEach } from "bun:test";
import * as path from "path";

const WORK_DIR = process.env.WORK_DIR || path.dirname(process.env.FIXTURE_PATH || ".");

let tokens: any, transformer: any, generator: any;

beforeEach(async () => {
  try {
    tokens = await import(path.join(WORK_DIR, "tokens.ts"));
    transformer = await import(path.join(WORK_DIR, "transformer.ts"));
    generator = await import(path.join(WORK_DIR, "generator.ts"));
  } catch {}
});

describe("Design Tokens", () => {
  it("createToken returns token object", () => {
    const createToken = tokens.createToken || tokens.default?.createToken;
    const token = createToken("color-primary", "#3b82f6", { type: "color" });
    expect(token).toHaveProperty("name");
    expect(token).toHaveProperty("value");
    expect(token.value).toBe("#3b82f6");
  });

  it("createGroup contains tokens", () => {
    const createToken = tokens.createToken || tokens.default?.createToken;
    const createGroup = tokens.createGroup || tokens.default?.createGroup;
    const t1 = createToken("primary", "#3b82f6", { type: "color" });
    const t2 = createToken("secondary", "#6366f1", { type: "color" });
    const group = createGroup("colors", [t1, t2]);
    expect(group.tokens.length || group.getTokens().length).toBe(2);
  });

  it("resolveReference resolves {color.primary}", () => {
    const createToken = tokens.createToken || tokens.default?.createToken;
    const resolveRef = tokens.resolveReference || tokens.default?.resolveReference;
    const tokenMap = {
      "color.primary": createToken("color.primary", "#3b82f6", { type: "color" }),
    };
    const result = resolveRef("{color.primary}", tokenMap);
    expect(result).toBe("#3b82f6");
  });

  it("flattenTokens produces dot-notation paths", () => {
    const createToken = tokens.createToken || tokens.default?.createToken;
    const createGroup = tokens.createGroup || tokens.default?.createGroup;
    const flattenTokens = tokens.flattenTokens || tokens.default?.flattenTokens;
    const group = createGroup("color", [
      createToken("primary", "#3b82f6", { type: "color" }),
      createToken("secondary", "#6366f1", { type: "color" }),
    ]);
    const flat = flattenTokens(group);
    expect(flat["color.primary"]).toBe("#3b82f6");
    expect(flat["color.secondary"]).toBe("#6366f1");
  });

  it("flattenTokens handles nested groups", () => {
    const createToken = tokens.createToken || tokens.default?.createToken;
    const createGroup = tokens.createGroup || tokens.default?.createGroup;
    const flattenTokens = tokens.flattenTokens || tokens.default?.flattenTokens;
    const inner = createGroup("brand", [
      createToken("primary", "#3b82f6", { type: "color" }),
    ]);
    const outer = createGroup("color", [], [inner]);
    const flat = flattenTokens(outer);
    expect(flat["color.brand.primary"]).toBe("#3b82f6");
  });
});

describe("Token Transformer", () => {
  it("toCSSVariables outputs --var-name: value format", () => {
    const toCSSVars = transformer.toCSSVariables || transformer.default?.toCSSVariables;
    const tokenMap = { "color.primary": "#3b82f6", "spacing.sm": "8px" };
    const result = toCSSVars(tokenMap);
    expect(result).toContain("--color-primary: #3b82f6");
    expect(result).toContain("--spacing-sm: 8px");
  });

  it("toTailwindConfig outputs object structure", () => {
    const toTailwind = transformer.toTailwindConfig || transformer.default?.toTailwindConfig;
    const tokenMap = { "color.primary": "#3b82f6", "color.secondary": "#6366f1" };
    const result = toTailwind(tokenMap);
    expect(typeof result).toBe("object");
    expect(result.color || result.colors).toBeTruthy();
  });

  it("toSCSSVariables outputs $var-name: value format", () => {
    const toSCSS = transformer.toSCSSVariables || transformer.default?.toSCSSVariables;
    const tokenMap = { "color.primary": "#3b82f6" };
    const result = toSCSS(tokenMap);
    expect(result).toContain("$color-primary: #3b82f6");
  });

  it("toJSON returns valid JSON", () => {
    const toJSON = transformer.toJSON || transformer.default?.toJSON;
    const tokenMap = { "color.primary": "#3b82f6" };
    const result = toJSON(tokenMap);
    const parsed = JSON.parse(result);
    expect(parsed).toHaveProperty("color.primary");
  });

  it("toTypeScript outputs const declaration", () => {
    const toTS = transformer.toTypeScript || transformer.default?.toTypeScript;
    const tokenMap = { "color.primary": "#3b82f6" };
    const result = toTS(tokenMap);
    expect(result).toContain("const");
    expect(result).toContain("#3b82f6");
  });
});

describe("Token Generator", () => {
  it("generateColorScale returns correct number of steps", () => {
    const genColor = generator.generateColorScale || generator.default?.generateColorScale;
    const scale = genColor("#3b82f6", 10);
    expect(scale.length).toBe(10);
  });

  it("generateColorScale includes lighter and darker values", () => {
    const genColor = generator.generateColorScale || generator.default?.generateColorScale;
    const scale = genColor("#3b82f6", 10);
    expect(scale[0]).not.toBe(scale[9]);
  });

  it("generateSpacingScale returns array of numbers", () => {
    const genSpacing = generator.generateSpacingScale || generator.default?.generateSpacingScale;
    const scale = genSpacing(4, 8);
    expect(Array.isArray(scale)).toBe(true);
    expect(scale.length).toBe(8);
    scale.forEach((v: any) => expect(typeof v).toBe("number"));
  });

  it("generateTypographyScale returns increasing sizes", () => {
    const genTypo = generator.generateTypographyScale || generator.default?.generateTypographyScale;
    const scale = genTypo(16, 6);
    expect(scale.length).toBe(6);
    for (let i = 1; i < scale.length; i++) {
      expect(scale[i]).toBeGreaterThan(scale[i - 1]);
    }
  });

  it("generateShadowScale returns array of shadow strings", () => {
    const genShadow = generator.generateShadowScale || generator.default?.generateShadowScale;
    const scale = genShadow(5);
    expect(scale.length).toBe(5);
    scale.forEach((s: any) => expect(typeof s).toBe("string"));
  });
});
