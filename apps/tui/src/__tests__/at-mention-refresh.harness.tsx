/**
 * Harness for at-mention.test.tsx: outside a git repo the @ list comes from a
 * walk of the project folder, and it reloads each time a mention opens, so a
 * file made after the first @ still shows (#3918 D2).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { bootApp, tick, waitFor } from "./app-driver.js";

async function main() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "8gent-at-refresh-"));
	fs.writeFileSync(path.join(dir, "alpha-first.ts"), "");
	process.chdir(dir);
	try {
		const app = await bootApp(160, 50);
		let m = app.mark();
		app.feed("@alpha");
		await waitFor(() => app.since(m).includes("alpha-first.ts"), "first file listed");
		app.feed(" ");
		await tick(300);
		fs.writeFileSync(path.join(dir, "beta-later.ts"), "");
		m = app.mark();
		app.feed("@beta");
		await waitFor(() => app.since(m).includes("beta-later.ts"), "file made later listed");
		app.emit({ phase: "refresh", ok: true });
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
	process.exit(0);
}

main().catch((e) => {
	console.log(JSON.stringify({ phase: "error", message: String(e?.message ?? e) }));
	process.exit(1);
});
