import { expect, test } from "bun:test";
import { bundledPackageDirs, checkBundle } from "./check-bundle-versions";

test("bundledPackageDirs finds hoisted, nested and scoped package folders", () => {
	const src = [
		"// node_modules/chalk/source/index.js",
		"// node_modules/chalk/node_modules/ansi-styles/index.js",
		"// node_modules/@alcalzone/ansi-tokenize/build/reduce.js",
		"// apps/tui/src/app.tsx",
	].join("\n");
	expect([...bundledPackageDirs(src)].sort()).toEqual([
		"node_modules/@alcalzone/ansi-tokenize",
		"node_modules/chalk",
		"node_modules/chalk/node_modules/ansi-styles",
	]);
});

test("checkBundle reports nothing for a bundle with no npm packages", () => {
	expect(checkBundle("// apps/tui/src/app.tsx\n")).toEqual([]);
});
