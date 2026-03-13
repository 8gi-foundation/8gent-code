/**
 * FS-MEGA-001 — SQLite Design System: Full Pipeline Test
 *
 * WORK_DIR contains:
 *   - design-db.ts (fixture)
 *   - schema.ts, tokens.ts, components.ts, themes.ts, renderer.ts, system.ts (LLM-generated)
 *
 * 22 tests across 6 areas: schema, tokens, components, themes, renderer, full pipeline.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";

const workDir = process.env.WORK_DIR;
if (!workDir) throw new Error("WORK_DIR env var required");

// Import LLM-generated entry point
const systemMod = await import(`${workDir}/system.ts`);
const createDesignSystem: Function =
  systemMod.default ?? systemMod.createDesignSystem;

if (!createDesignSystem || typeof createDesignSystem !== "function") {
  throw new Error("system.ts must export createDesignSystem function");
}

// Also import individual modules for targeted testing
let TokenEngineClass: any, ComponentRegistryClass: any, ThemeEngineClass: any, RendererClass: any;
let runMigrations: Function;
try {
  const schemaMod = await import(`${workDir}/schema.ts`);
  runMigrations = schemaMod.runMigrations ?? schemaMod.default;

  const tokensMod = await import(`${workDir}/tokens.ts`);
  TokenEngineClass = tokensMod.TokenEngine ?? tokensMod.default;

  const componentsMod = await import(`${workDir}/components.ts`);
  ComponentRegistryClass = componentsMod.ComponentRegistry ?? componentsMod.default;

  const themesMod = await import(`${workDir}/themes.ts`);
  ThemeEngineClass = themesMod.ThemeEngine ?? themesMod.default;

  const rendererMod = await import(`${workDir}/renderer.ts`);
  RendererClass = rendererMod.Renderer ?? rendererMod.default;
} catch (e) {
  // Individual imports may fail, but system.ts should still work
}

describe("FS-MEGA-001: Design System", () => {
  let sys: any;

  beforeAll(() => {
    sys = createDesignSystem();
  });

  afterAll(() => {
    sys?.db?.close?.();
  });

  // ── 1. Schema ───────────────────────────────────────────────────

  describe("Schema", () => {
    test("all required tables exist after migration", () => {
      const db = sys.db;
      const tables = ["design_tokens", "components", "component_variants", "themes", "theme_tokens"];
      for (const t of tables) {
        const exists = db.tableExists?.(t) ??
          db.query?.(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`, [t])?.length > 0;
        expect(exists).toBeTruthy();
      }
    });

    test("design_tokens has unique constraint on (category, name)", () => {
      const tokens = sys.tokens;
      tokens.create("color", "test-unique", "#000");
      expect(() => tokens.create("color", "test-unique", "#FFF")).toThrow();
    });
  });

  // ── 2. Tokens ───────────────────────────────────────────────────

  describe("Token Engine", () => {
    test("create and retrieve a token", () => {
      const tokens = sys.tokens;
      tokens.create("color", "brand", "#FF6600");
      const tok = tokens.get("color", "brand");
      expect(tok).toBeDefined();
      expect(tok.value ?? tok.override_value).toBe("#FF6600");
    });

    test("list tokens by category", () => {
      sys.seed?.();
      const colors = sys.tokens.list("color");
      expect(colors.length).toBeGreaterThanOrEqual(5);
    });

    test("update a token value", () => {
      sys.tokens.create("spacing", "test-update", "8px");
      sys.tokens.update("spacing", "test-update", "12px");
      const tok = sys.tokens.get("spacing", "test-update");
      expect(tok.value).toBe("12px");
    });

    test("delete a token", () => {
      sys.tokens.create("spacing", "to-delete", "4px");
      sys.tokens.delete("spacing", "to-delete");
      const tok = sys.tokens.get("spacing", "to-delete");
      expect(tok).toBeNull();
    });

    test("resolve a simple token value", () => {
      sys.tokens.create("color", "resolve-test", "#ABCDEF");
      const val = sys.tokens.resolve("color", "resolve-test");
      expect(val).toBe("#ABCDEF");
    });

    test("resolve a reference token ($category.name)", () => {
      sys.tokens.create("color", "ref-target", "#123456");
      sys.tokens.create("color", "ref-source", "$color.ref-target");
      const val = sys.tokens.resolve("color", "ref-source");
      expect(val).toBe("#123456");
    });

    test("detect circular reference and throw", () => {
      sys.tokens.create("color", "circ-a", "$color.circ-b");
      sys.tokens.create("color", "circ-b", "$color.circ-a");
      expect(() => sys.tokens.resolve("color", "circ-a")).toThrow();
    });
  });

  // ── 3. Components ───────────────────────────────────────────────

  describe("Component Registry", () => {
    test("register and retrieve a component", () => {
      sys.seed?.();
      const btn = sys.components.get("Button");
      expect(btn).toBeDefined();
      expect(btn.name).toBe("Button");
    });

    test("component has variants after seed", () => {
      sys.seed?.();
      const btn = sys.components.get("Button");
      // Variants might be attached as .variants array or separate query
      const variants = btn.variants ?? [];
      const primaryVariant = sys.components.getVariant?.("Button", "primary");
      expect(variants.length > 0 || primaryVariant).toBeTruthy();
    });

    test("add a variant to an existing component", () => {
      sys.components.register?.("TestComp", "display", {}, {}) ??
        sys.components.create?.("TestComp", "display", {}, {});
      sys.components.addVariant("TestComp", "danger", { backgroundColor: "$color.error" });
      const v = sys.components.getVariant("TestComp", "danger");
      expect(v).toBeDefined();
    });

    test("delete component removes its variants too", () => {
      sys.components.register?.("ToDelete", "display", {}, {}) ??
        sys.components.create?.("ToDelete", "display", {}, {});
      sys.components.addVariant("ToDelete", "v1", { color: "red" });
      sys.components.delete("ToDelete");
      const comp = sys.components.get("ToDelete");
      expect(comp).toBeNull();
    });

    test("list components by category", () => {
      sys.seed?.();
      const all = sys.components.list();
      expect(all.length).toBeGreaterThanOrEqual(2);
    });
  });

  // ── 4. Themes ───────────────────────────────────────────────────

  describe("Theme Engine", () => {
    test("create and retrieve a theme", () => {
      sys.seed?.();
      const light = sys.themes.get("light");
      expect(light).toBeDefined();
      expect(light.name).toBe("light");
    });

    test("set a token override in a theme", () => {
      sys.seed?.();
      sys.themes.setOverride("dark", "color", "primary", "#60A5FA");
      const val = sys.themes.resolveToken("dark", "color", "primary");
      expect(val).toBe("#60A5FA");
    });

    test("theme resolves default token when no override exists", () => {
      sys.seed?.();
      // "success" color should NOT be overridden in dark theme by default
      const val = sys.themes.resolveToken("dark", "color", "success");
      expect(val).toBe("#22C55E");
    });

    test("theme inheritance — child inherits parent overrides", () => {
      sys.seed?.();
      // Create a child theme based on dark
      sys.themes.create("high-contrast", "High contrast dark", "dark");
      // Dark theme overrides background → #0F172A
      const bg = sys.themes.resolveToken("high-contrast", "color", "background");
      expect(bg).toBe("#0F172A");
    });

    test("child theme can override parent values", () => {
      sys.seed?.();
      sys.themes.create?.("custom-child", "Custom", "dark");
      sys.themes.setOverride("custom-child", "color", "background", "#000000");
      const val = sys.themes.resolveToken("custom-child", "color", "background");
      expect(val).toBe("#000000");
    });
  });

  // ── 5. Renderer ─────────────────────────────────────────────────

  describe("Renderer", () => {
    test("render a component to HTML string", () => {
      sys.seed?.();
      const html = sys.renderer.render("Button", {
        children: "Click me",
        variant: "primary",
      });
      expect(typeof html).toBe("string");
      expect(html).toContain("Click me");
      expect(html.toLowerCase()).toContain("<");
    });

    test("rendered HTML includes resolved token values (not $references)", () => {
      sys.seed?.();
      const html = sys.renderer.render("Button", {
        children: "Test",
        variant: "primary",
      });
      // Should NOT contain raw $references
      expect(html).not.toContain("$color.");
      expect(html).not.toContain("$spacing.");
    });

    test("render with theme applies theme overrides", () => {
      sys.seed?.();
      const lightHtml = sys.renderer.render("Card", { children: "Light" }, { theme: "light" });
      const darkHtml = sys.renderer.render("Card", { children: "Dark" }, { theme: "dark" });
      // Both should render, and they should differ (dark has different bg)
      expect(lightHtml).toContain("Light");
      expect(darkHtml).toContain("Dark");
    });

    test("renderToCSS generates CSS class definition", () => {
      sys.seed?.();
      if (!sys.renderer.renderToCSS) return; // optional method
      const css = sys.renderer.renderToCSS("Button");
      expect(typeof css).toBe("string");
      expect(css).toContain("Button");
    });
  });

  // ── 6. Full Pipeline ───────────────────────────────────────────

  describe("Full Pipeline", () => {
    test("seed creates a complete design system", () => {
      const fresh = createDesignSystem();
      fresh.seed();

      // Check tokens exist
      const colors = fresh.tokens.list("color");
      expect(colors.length).toBeGreaterThanOrEqual(5);

      // Check components exist
      const comps = fresh.components.list();
      expect(comps.length).toBeGreaterThanOrEqual(2);

      // Check themes exist
      const themes = fresh.themes.list();
      expect(themes.length).toBeGreaterThanOrEqual(2);

      fresh.db.close();
    });

    test("end-to-end: create token → register component → apply theme → render", () => {
      const fresh = createDesignSystem();
      fresh.seed();

      // Add a custom token
      fresh.tokens.create("color", "custom-brand", "#E11D48");

      // Register a Badge component
      fresh.components.register?.(
        "Badge",
        "display",
        { label: { type: "string", required: true } },
        { backgroundColor: "$color.custom-brand", padding: "$spacing.xs", borderRadius: "$radius.full" }
      ) ?? fresh.components.create?.(
        "Badge",
        "display",
        { label: { type: "string", required: true } },
        { backgroundColor: "$color.custom-brand", padding: "$spacing.xs", borderRadius: "$radius.full" }
      );

      // Render it
      const html = fresh.renderer.render("Badge", { children: "New", label: "New" });
      expect(html).toContain("New");
      // The rendered output should have the resolved color
      expect(html).not.toContain("$color.custom-brand");

      fresh.db.close();
    });

    test("full system survives multiple seed calls without duplicates", () => {
      const fresh = createDesignSystem();
      fresh.seed();
      // Second seed should not throw (INSERT OR IGNORE / ON CONFLICT)
      expect(() => fresh.seed()).not.toThrow();
      fresh.db.close();
    });
  });
});
