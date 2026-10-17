import { describe, expect, test } from "bun:test";
import { findAssetReads, missingAssetReads } from "./packed-install-probes";

const bundle = [
	'var __dirname = (import.meta.dir + "/../packages/table");',
	'const a = path.join(__dirname, "schema.sql");',
	'var __dirname = (import.meta.dir + "/../node_modules/source-map/lib");',
	'const w = path.join(__dirname, "mappings.wasm");',
	'const p = fs.readFileSync(new URL("../package.json", import.meta.url));',
].join("\n");

describe("packed asset reads", () => {
	test("each literal read resolves against the nearest __dirname", () => {
		const t = findAssetReads(bundle, "/pkg/dist").map((r) => r.target);
		expect(t).toEqual([
			"/pkg/packages/table/schema.sql",
			"/pkg/node_modules/source-map/lib/mappings.wasm",
			"/pkg/package.json",
		]);
	});
	test("reports the reads whose target is not in the install", () => {
		const present = new Set([
			"/pkg/package.json",
			"/pkg/node_modules/source-map/lib/mappings.wasm",
		]);
		const missing = missingAssetReads(bundle, "/pkg/dist", (p) => present.has(p));
		expect(missing.map((r) => r.target)).toEqual(["/pkg/packages/table/schema.sql"]);
	});
});
