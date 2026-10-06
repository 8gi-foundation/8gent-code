/**
 * Deck themes (#3591): generation from the design-systems DB, brand-ban hue
 * remap, and the list / apply / mix operations behind the deck_theme tool.
 */

import { describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	THEMES_DIR,
	applyTheme,
	buildThemeCss,
	contrast,
	generateAll,
	listThemes,
	loadIndex,
	mixTheme,
	remapBannedHue,
	setFrontMatterTheme,
} from "../deck-themes";

function hueOf(hex: string): { h: number; chroma: number } {
	const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255);
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	const d = max - min;
	if (d === 0) return { h: 0, chroma: 0 };
	let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
	h = (h * 60 + 360) % 360;
	return { h, chroma: d };
}

const tmp = () => mkdtempSync(join(tmpdir(), "deck-themes-test-"));
const deckWith = (body: string) => {
	const dir = tmp();
	const deck = join(dir, "deck.md");
	writeFileSync(deck, body);
	return { dir, deck };
};

describe("remapBannedHue", () => {
	test("moves purple/pink/violet out of 270-350", () => {
		for (const h of [270, 290, 309, 310, 330, 350]) {
			const out = Number.parseFloat(remapBannedHue(`${h} 70% 50%`).split(" ")[0]);
			expect(out < 270 || out > 350).toBe(true);
		}
	});
	test("leaves other hues alone and neutralises near-grey tints", () => {
		expect(remapBannedHue("210 100% 45%")).toBe("210 100% 45%");
		expect(remapBannedHue("300 4% 50%")).toBe("0 0% 50%");
	});
});

describe("committed themes", () => {
	const index = loadIndex();
	test("one CSS file per index entry, at least 40 themes", () => {
		const css = readdirSync(THEMES_DIR)
			.filter((f) => f.endsWith(".css"))
			.sort();
		expect(css).toEqual(index.map((e) => `${e.name}.css`).sort());
		expect(index.length).toBeGreaterThanOrEqual(40);
	});
	test("every theme declares its name, imports default, styles lead and invert", () => {
		for (const e of index) {
			const css = readFileSync(join(THEMES_DIR, `${e.name}.css`), "utf8");
			expect(css).toContain(`/* @theme ${e.name} */`);
			expect(css).toContain("@import 'default';");
			expect(css).toContain("section.lead");
			expect(css).toContain("section.invert");
		}
	});
	test("no colour in any theme falls in the banned 270-350 hue band", () => {
		for (const e of index) {
			const css = readFileSync(join(THEMES_DIR, `${e.name}.css`), "utf8");
			for (const hex of css.match(/#[0-9a-f]{6}\b/g) ?? []) {
				const { h, chroma } = hueOf(hex);
				if (chroma > 0) expect(h < 270 || h > 350).toBe(true);
			}
		}
	});
	test("body text and heading text are readable on the slide background", () => {
		for (const e of index) {
			const css = readFileSync(join(THEMES_DIR, `${e.name}.css`), "utf8");
			const sec = css.match(/section \{[^}]*\}/)![0];
			const bg = sec.match(/background: (#[0-9a-f]{6})/)![1];
			const fg = sec.match(/\n {2}color: (#[0-9a-f]{6})/)![1];
			expect(contrast(fg, bg)).toBeGreaterThanOrEqual(4.5);
			const h1 = css.match(/section h1, [^{]*\{\s*font-family: [^;]*;\s*color: (#[0-9a-f]{6})/)![1];
			expect(contrast(h1, bg)).toBeGreaterThanOrEqual(4.5);
		}
	});
	test("committed output matches a fresh generation from the DB (no drift)", async () => {
		const out = tmp();
		const n = await generateAll(undefined, out);
		expect(n).toBe(index.length);
		expect(readFileSync(join(out, "index.json"), "utf8")).toBe(
			readFileSync(join(THEMES_DIR, "index.json"), "utf8"),
		);
		for (const e of index) {
			expect(readFileSync(join(out, `${e.name}.css`), "utf8")).toBe(
				readFileSync(join(THEMES_DIR, `${e.name}.css`), "utf8"),
			);
		}
	});
});

describe("list", () => {
	test("returns name, mood and exactly 3 hex swatches", () => {
		const rows = listThemes();
		expect(rows.length).toBe(loadIndex().length);
		for (const r of rows) {
			expect(r.name).toBeTruthy();
			expect(r.mood).toBeTruthy();
			expect(r.swatches).toHaveLength(3);
			for (const s of r.swatches) expect(s).toMatch(/^#[0-9a-f]{6}$/);
		}
	});
});

describe("setFrontMatterTheme", () => {
	test("creates front matter when absent", () => {
		expect(setFrontMatterTheme("# Hi\n", "apple")).toBe(
			"---\nmarp: true\ntheme: apple\n---\n\n# Hi\n",
		);
	});
	test("replaces an existing theme and keeps other keys", () => {
		const out = setFrontMatterTheme(
			"---\nmarp: true\ntheme: default\npaginate: true\n---\n\n# Hi\n",
			"apple",
		);
		expect(out).toContain("theme: apple");
		expect(out).not.toContain("theme: default");
		expect(out).toContain("paginate: true");
	});
	test("adds theme and marp keys to a bare front matter block", () => {
		const out = setFrontMatterTheme("---\npaginate: true\n---\n\nx\n", "apple");
		expect(out).toContain("marp: true");
		expect(out).toContain("theme: apple");
	});
});

describe("apply", () => {
	test("sets the theme and copies the CSS next to the deck", () => {
		const { dir, deck } = deckWith("---\nmarp: true\n---\n\n# A\n\n---\n\n# B\n");
		const r = applyTheme(deck, "apple");
		expect(readFileSync(deck, "utf8")).toContain("theme: apple");
		expect(readFileSync(join(dir, "apple.css"), "utf8")).toBe(
			readFileSync(join(THEMES_DIR, "apple.css"), "utf8"),
		);
		expect(r.render).toContain("--theme-set apple.css");
	});
	test("rejects unknown themes and missing decks", () => {
		const { deck } = deckWith("# A\n");
		expect(() => applyTheme(deck, "no-such-theme")).toThrow(/Unknown deck theme/);
		expect(() => applyTheme("/nonexistent/deck.md", "apple")).toThrow(/not found/);
	});
});

describe("mix", () => {
	test("writes a derived theme: colours from palette, fonts from type", () => {
		const idx = loadIndex();
		const a = idx[0];
		const b = idx.find((e) => e.typography.fontFamily !== a.typography.fontFamily)!;
		const { dir, deck } = deckWith("# A\n");
		const r = mixTheme(deck, a.name, b.name);
		expect(r.theme).toBe(`${a.name}-x-${b.name}`);
		const css = readFileSync(join(dir, `${r.theme}.css`), "utf8");
		expect(css).toContain(`/* @theme ${r.theme} */`);
		expect(css).toContain(a.colors.background);
		expect(css).toContain(b.typography.fontFamily);
		expect(css).not.toContain(a.typography.fontFamily);
		expect(readFileSync(deck, "utf8")).toContain(`theme: ${r.theme}`);
	});
	test("rejects an unknown palette or type", () => {
		const { deck } = deckWith("# A\n");
		expect(() => mixTheme(deck, "apple", "nope")).toThrow(/Unknown deck theme/);
		expect(() => mixTheme(deck, "nope", "apple")).toThrow(/Unknown deck theme/);
	});
});

describe("buildThemeCss", () => {
	test("falls back to a readable text colour when the palette pair is unreadable", () => {
		const c = { ...loadIndex()[0].colors, background: "#ffffff", foreground: "#fafafa" };
		const css = buildThemeCss("t", c, loadIndex()[0].typography);
		const fg = css.match(/section \{[^}]*\n {2}color: (#[0-9a-f]{6})/)![1];
		expect(contrast(fg, "#ffffff")).toBeGreaterThanOrEqual(4.5);
	});
});

describe("deck_theme tool wiring", () => {
	test("registered in the AI SDK tools and in the design category", async () => {
		const { agentTools } = await import("../../ai/tools");
		const { TOOL_CATEGORIES } = await import("../../eight/tool-registry");
		expect(agentTools.deck_theme).toBeDefined();
		expect(TOOL_CATEGORIES.design).toContain("deck_theme");
		expect(agentTools.deck_theme.description).toContain("has no theme");
	});
	test("list, apply and argument errors go through execute", async () => {
		const { agentTools } = await import("../../ai/tools");
		const run = (a: Record<string, unknown>) =>
			(agentTools.deck_theme.execute as (a: unknown, o: unknown) => Promise<any>)(a, {});
		expect((await run({ action: "list" })).themes.length).toBeGreaterThanOrEqual(40);
		expect((await run({ action: "apply" })).error).toMatch(/needs deck/);
		const { dir, deck } = deckWith("# A\n");
		const { setToolContext, getToolContext } = await import("../../ai/tools");
		const prev = getToolContext();
		setToolContext({ workingDirectory: dir });
		try {
			expect((await run({ action: "apply", deck: "../../etc/x.md" })).error).toBeTruthy();
			expect((await run({ action: "apply", deck: "deck.md", name: "apple" })).theme).toBe("apple");
		} finally {
			setToolContext(prev);
		}
		expect((await run({ action: "apply", deck })).error).toMatch(/needs name/);
		expect((await run({ action: "mix", deck, palette: "apple" })).error).toMatch(
			/palette and type/,
		);
		expect(readFileSync(deck, "utf8")).toContain("theme: apple");
	});
});

describe("deck_theme in the local agent path (ToolExecutor + CORE_TOOLS)", () => {
	test("ToolExecutor defines and executes deck_theme", async () => {
		const { ToolExecutor } = await import("../../eight/tools");
		const { dir, deck } = deckWith("# A\n");
		const ex = new ToolExecutor(dir);
		expect(JSON.stringify(ex.getToolDefinitions())).toContain('"name":"deck_theme"');
		const listed = JSON.parse(await ex.execute("deck_theme", { action: "list" }));
		expect(listed.themes.length).toBeGreaterThanOrEqual(40);
		const out = JSON.parse(
			await ex.execute("deck_theme", { action: "apply", deck: "deck.md", name: "apple" }),
		);
		expect(out.theme).toBe("apple");
		expect(readFileSync(deck, "utf8")).toContain("theme: apple");
		expect(
			await ex.execute("deck_theme", { action: "mix", deck: "deck.md", palette: "apple" }),
		).toMatch(/needs palette and type/);
	});
	test("agent CORE_TOOLS allowlist and the system prompt name deck_theme", () => {
		const agent = readFileSync(join(import.meta.dir, "../../eight/agent.ts"), "utf8");
		const core = agent.slice(agent.indexOf("const CORE_TOOLS = ["));
		expect(core.slice(0, core.indexOf("];"))).toContain('"deck_theme"');
		const prompt = readFileSync(
			join(import.meta.dir, "../../eight/prompts/system-prompt.ts"),
			"utf8",
		);
		expect(prompt).toContain("\\`deck_theme\\`");
	});
});

describe("deck_theme write safety (8SO review)", () => {
	const mk = async (opts: Record<string, unknown> = {}) => {
		const { ToolExecutor } = await import("../../eight/tools");
		const base = tmp();
		const ws = join(base, "ws");
		mkdirSync(ws);
		writeFileSync(join(ws, "deck.md"), "# A\n");
		return { base, ws, ex: new ToolExecutor(ws, "primary", undefined, opts) };
	};
	const apply = (
		ex: { execute(n: string, a: Record<string, unknown>): Promise<string> },
		deck: string,
	) => ex.execute("deck_theme", { action: "apply", deck, name: "apple" });

	test("traversal out of the workspace is refused and nothing is written", async () => {
		const { base, ex } = await mk();
		mkdirSync(join(base, "out"));
		writeFileSync(join(base, "out", "victim.md"), "# V\n");
		const r = await apply(ex, "../out/victim.md");
		expect(r).toMatch(/outside|blocked/i);
		expect(readFileSync(join(base, "out", "victim.md"), "utf8")).toBe("# V\n");
		expect(existsSync(join(base, "out", "apple.css"))).toBe(false);
	});
	test("a symlink pointing outside the workspace is refused", async () => {
		const { base, ws, ex } = await mk();
		writeFileSync(join(base, "secret.md"), "# S\n");
		symlinkSync(join(base, "secret.md"), join(ws, "link.md"));
		expect(await apply(ex, "link.md")).toMatch(/outside|blocked/i);
		expect(readFileSync(join(base, "secret.md"), "utf8")).toBe("# S\n");
	});
	test("a symlinked CSS destination is not followed", async () => {
		const { base, ws, ex } = await mk();
		writeFileSync(join(base, "target.txt"), "keep");
		symlinkSync(join(base, "target.txt"), join(ws, "apple.css"));
		expect(await apply(ex, "deck.md")).toMatch(/symlink/i);
		expect(readFileSync(join(base, "target.txt"), "utf8")).toBe("keep");
	});
	test("a non-.md file is refused and left intact", async () => {
		const { ws, ex } = await mk();
		writeFileSync(join(ws, "notes.txt"), "plain");
		expect(await apply(ex, "notes.txt")).toMatch(/\.md/);
		expect(readFileSync(join(ws, "notes.txt"), "utf8")).toBe("plain");
	});
	test("a hostile filename never reaches the returned marp command", async () => {
		const { ws, ex } = await mk();
		writeFileSync(join(ws, "x; touch pwned.md"), "# A\n");
		const r = await apply(ex, "x; touch pwned.md");
		expect(r).toMatch(/characters outside/);
		expect(r).not.toContain("marp ");
		expect(() => applyTheme(join(ws, "x; touch pwned.md"), "apple")).toThrow(/characters outside/);
		expect(() => mixTheme(join(ws, "x; touch pwned.md"), "apple", "apple")).toThrow(
			/characters outside/,
		);
	});
	test("edit scope (allowedPaths) covers the deck and its CSS", async () => {
		const { ws, ex } = await mk({ allowedPaths: ["other.md"] });
		const r = await apply(ex, "deck.md");
		expect(r).toContain("SCOPE BLOCKED");
		expect(readFileSync(join(ws, "deck.md"), "utf8")).toBe("# A\n");
		const onlyDeck = await mk({ allowedPaths: ["deck.md"] });
		expect(await apply(onlyDeck.ex, "deck.md")).toContain("SCOPE BLOCKED"); // apple.css is out of scope
		const both = await mk({ allowedPaths: ["deck.md", "apple.css"] });
		expect(JSON.parse(await apply(both.ex, "deck.md")).theme).toBe("apple");
		expect(
			await mk({ allowedPaths: ["other.md"] }).then((m) =>
				m.ex.execute("deck_theme", { action: "list" }),
			),
		).toContain("themes");
	});
});
