#!/usr/bin/env bun
/**
 * Build the two npm bundles: dist/cli.js and dist/tui.js (#3219).
 *
 * Replaces the inline `bun build ... --external react-devtools-core` commands.
 * Marking react-devtools-core external made Bun hoist Ink's
 * `import devtools from "react-devtools-core"` to the top of dist/tui.js, so
 * every npm install crashed on first launch with "Cannot find package
 * 'react-devtools-core'": it is an optional peer of Ink and is not installed.
 * Ink only loads it when DEV=true, so it is resolved to an inert stub here.
 *
 * sharp stays external: it is a real dependency and only imported lazily.
 * build-finalize.js runs afterwards and strips build-machine paths.
 *
 *   bun scripts/build-bundles.ts          # both bundles
 *   bun scripts/build-bundles.ts --tui    # dist/tui.js only
 */
import type { BunPlugin } from "bun";

const stubDevtools: BunPlugin = {
	name: "stub-react-devtools-core",
	setup(build) {
		build.onResolve({ filter: /^react-devtools-core$/ }, () => ({
			path: "react-devtools-core",
			namespace: "stub-devtools",
		}));
		build.onLoad({ filter: /.*/, namespace: "stub-devtools" }, () => ({
			contents: "export default { initialize() {}, connectToDevTools() {} };",
			loader: "js",
		}));
	},
};

const targets = [
	{ name: "cli", entry: "bin/8gent.ts", external: [] as string[] },
	{ name: "tui", entry: "apps/tui/src/index.tsx", external: ["sharp"] },
].filter((t) => !process.argv.includes("--tui") || t.name === "tui");

const root = new URL("..", import.meta.url).pathname;

for (const t of targets) {
	const result = await Bun.build({
		entrypoints: [root + t.entry],
		outdir: root + "dist",
		naming: `${t.name}.js`,
		target: "bun",
		external: t.external,
		plugins: [stubDevtools],
	});
	if (!result.success) {
		for (const log of result.logs) console.error(log);
		process.exit(1);
	}
	const size = result.outputs[0]?.size ?? 0;
	console.log(`[build-bundles] dist/${t.name}.js ${(size / 1024 / 1024).toFixed(2)} MB`);
}
