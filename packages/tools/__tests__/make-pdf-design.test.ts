/**
 * Tests for make_pdf design inheritance (packages/tools/make-pdf.ts applyDesign).
 *
 * Proves a PDF inherits the design-systems tokens like every other surface: the
 * resolved CSS variables are injected into the HTML the renderer receives, and
 * the chosen systemId is stamped for provenance. Hermetic via EIGHT_DESIGN_DB.
 */

import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { __resetDesignContextCache } from "../../design-systems/context";
import { generateCssVariables } from "../../design-systems/query";
import { seedDatabase } from "../../design-systems/seed";
import { initDatabase } from "../../design-systems/db";
import { applyDesign } from "../make-pdf";

let emptyDbPath: string;
let seededDbPath: string;
let tmpRoot: string;

beforeAll(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mkpdf-ds-"));
	emptyDbPath = path.join(tmpRoot, "empty.db");
	initDatabase(emptyDbPath);
	seededDbPath = path.join(tmpRoot, "seeded.db");
	seedDatabase(seededDbPath);
});

beforeEach(() => __resetDesignContextCache());

describe("applyDesign", () => {
	test("passthrough when no design is requested", () => {
		process.env.EIGHT_DESIGN_DB = seededDbPath;
		const out = applyDesign({ html: "<h1>hi</h1>" });
		expect(out.designSystemId).toBeUndefined();
		expect(out.input.html).toBe("<h1>hi</h1>");
	});

	test("injects resolved tokens into inline HTML + stamps systemId", () => {
		process.env.EIGHT_DESIGN_DB = seededDbPath;
		const out = applyDesign({ html: "<html><head></head><body>x</body></html>", designSystemId: "vercel" });
		expect(out.designSystemId).toBe("vercel");
		// The exact :root token block from the resolver must be present verbatim.
		expect(out.input.html).toContain(generateCssVariables("vercel") as string);
		expect(out.input.html).toContain("<style>");
		// Injected before </head> when a head exists.
		expect(out.input.html!.indexOf("<style>")).toBeLessThan(out.input.html!.indexOf("</head>"));
	});

	test("reads htmlPath, injects, and switches to inline html", () => {
		process.env.EIGHT_DESIGN_DB = seededDbPath;
		const p = path.join(tmpRoot, "doc.html");
		fs.writeFileSync(p, "<html><body>from disk</body></html>");
		const out = applyDesign({ htmlPath: p, designSystemId: "vercel" });
		expect(out.designSystemId).toBe("vercel");
		expect(out.input.htmlPath).toBeUndefined();
		expect(out.input.html).toContain("from disk");
		expect(out.input.html).toContain("--theme-primary");
	});

	test("best-effort: unavailable DB renders unthemed (no throw, no stamp)", () => {
		process.env.EIGHT_DESIGN_DB = emptyDbPath;
		const out = applyDesign({ html: "<h1>hi</h1>", designSystemId: "vercel" });
		expect(out.designSystemId).toBeUndefined();
		expect(out.input.html).toBe("<h1>hi</h1>");
	});
});
