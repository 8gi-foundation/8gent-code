/**
 * Ink imports react-devtools-core, an optional peer that is not installed, and
 * only uses it when DEV=true. Every bundle that holds the TUI (dist/tui.js, the
 * compiled binaries) resolves it to this inert stub (#3219).
 */
import type { BunPlugin } from "bun";

export const stubDevtools: BunPlugin = {
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
