#!/usr/bin/env bun
/**
 * Build the Node-runnable bundles: dist/node/cli.js and dist/node/tui.js.
 *
 * The Bun bundles (dist/cli.js, dist/tui.js) are untouched. These two run on
 * plain Node 22.5+ with no Bun installed: "bun" and "bun:sqlite" are aliased
 * to the shims in packages/node-compat, and the entries install globalThis.Bun
 * before any 8gent code runs. bin/8gent-run.js picks them when Bun is absent.
 *
 *   bun scripts/build-node.ts
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BunPlugin } from "bun";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const compat = join(root, "packages", "node-compat");

const alias: BunPlugin = {
	name: "node-compat-alias",
	setup(build) {
		// Virtual entries: install the Bun global first, then run the real entry. (Real files for
		// these confuse tsc: importing bin/8gent.ts from a second root changes how it resolves.)
		build.onResolve({ filter: /^node-entry:/ }, (a) => ({ path: a.path, namespace: "node-entry" }));
		build.onLoad({ filter: /.*/, namespace: "node-entry" }, (a) => {
			const real =
				a.path === "node-entry:cli"
					? join(root, "bin", "8gent.ts")
					: join(root, "apps", "tui", "src", "index.tsx");
			return {
				contents: `import ${JSON.stringify(join(compat, "install-global.ts"))};\nimport ${JSON.stringify(real)};\n`,
				loader: "js",
			};
		});
		build.onResolve({ filter: /^bun$/ }, () => ({ path: join(compat, "bun-shim.ts") }));
		build.onResolve({ filter: /^bun:sqlite$/ }, () => ({ path: join(compat, "bun-sqlite.ts") }));
		// import.meta.dir / .path are Bun-only; Node's equivalents are dirname / filename.
		// In a bundle both resolve to the bundle's own location, the same as a Bun bundle's unbaked paths.
		build.onLoad({ filter: /\.(ts|tsx)$/ }, async (args) => {
			if (args.path.includes("/node_modules/")) return undefined;
			const src = await Bun.file(args.path).text();
			if (!/import\.meta\.(dir|path)\b/.test(src)) return undefined;
			const contents = src
				.replace(/import\.meta\.dir\b(?!name)/g, "import.meta.dirname")
				.replace(/import\.meta\.path\b/g, "import.meta.filename");
			return { contents, loader: args.path.endsWith("x") ? "tsx" : "ts" };
		});
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

for (const t of [
	{ name: "cli", entry: "node-entry:cli", external: [] as string[] },
	{ name: "tui", entry: "node-entry:tui", external: ["sharp"] },
]) {
	const result = await Bun.build({
		entrypoints: [t.entry],
		outdir: join(root, "dist", "node"),
		naming: `${t.name}.js`,
		target: "node",
		external: t.external,
		plugins: [alias],
	});
	if (!result.success) {
		for (const log of result.logs) console.error(log);
		process.exit(1);
	}
	console.log(
		`[build-node] dist/node/${t.name}.js ${((result.outputs[0]?.size ?? 0) / 1048576).toFixed(2)} MB`,
	);
}
