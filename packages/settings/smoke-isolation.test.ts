/**
 * scripts/smoke.ts must never read or write the operator's settings (#3393).
 *
 * Its settings checks save, overwrite and delete settings.json. They used to
 * do that to the real ~/.8gent/settings.json and "restore" it from a backup,
 * which rewrote the file on every run and lost it outright if the run died
 * mid-check. settings/path also compared against os.homedir(), so it failed
 * whenever EIGHT_HOME was set.
 *
 * This runs the real harness in a subprocess against a fake home holding a
 * sentinel settings file, then checks the file was not touched (bytes and
 * mtime), the settings checks passed, and the harness removed its own temp
 * home.
 */
import { describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "..", "..");
const SENTINEL = `${JSON.stringify({ voice: { ttsVoice: "OperatorSentinel" } })}\n`;
const OLD = new Date("2020-01-01T00:00:00Z");

const SETTINGS_CHECKS = [
	"settings/load",
	"settings/round-trip",
	"settings/path",
	"settings/deep-merge",
	"settings/key-helpers",
	"onboarding/agent-names-defaults",
	"onboarding/agent-names-roundtrip",
];

type Row = { name: string; ok: boolean; detail?: string };

async function runSmoke(withEightHome: boolean) {
	const root = mkdtempSync(join(tmpdir(), "smoke-isolation-"));
	try {
		const home = join(root, "home");
		const tmp = join(root, "tmp");
		mkdirSync(tmp, { recursive: true });
		// The "real" home is HOME, or EIGHT_HOME when the operator sets it.
		const operatorHome = withEightHome ? join(root, "eight-home") : home;
		const file = join(operatorHome, ".8gent", "settings.json");
		mkdirSync(join(operatorHome, ".8gent"), { recursive: true });
		mkdirSync(home, { recursive: true });
		writeFileSync(file, SENTINEL);
		utimesSync(file, OLD, OLD);

		const env: Record<string, string> = { ...(process.env as Record<string, string>) };
		env.HOME = home;
		env.TMPDIR = tmp;
		if (withEightHome) env.EIGHT_HOME = operatorHome;
		else delete env.EIGHT_HOME;

		const proc = Bun.spawn(
			[process.execPath, "scripts/smoke.ts", "--skip-network"],
			{ cwd: REPO, env, stdout: "pipe", stderr: "pipe" },
		);
		const out = await new Response(proc.stdout).text();
		await proc.exited;

		const rows: Row[] = out
			.split("\n")
			.filter((l) => l.startsWith("{"))
			.map((l) => JSON.parse(l));
		return {
			rows,
			content: readFileSync(file, "utf-8"),
			mtimeMs: statSync(file).mtimeMs,
			leftovers: readdirSync(tmp).filter((n) => n.startsWith("8gent-smoke-home-")),
		};
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

function expectIsolated(r: Awaited<ReturnType<typeof runSmoke>>) {
	const byName = new Map(r.rows.map((row) => [row.name, row]));
	for (const name of SETTINGS_CHECKS) {
		const row = byName.get(name);
		expect(row, `${name} did not run`).toBeDefined();
		expect(row?.ok, `${name}: ${row?.detail}`).toBe(true);
	}
	expect(r.content).toBe(SENTINEL);
	expect(r.mtimeMs).toBe(OLD.getTime());
	expect(r.leftovers).toEqual([]);
}

describe("smoke.ts settings checks (#3393)", () => {
	test("leave the settings file under HOME untouched", async () => {
		expectIsolated(await runSmoke(false));
	}, 180_000);

	test("leave the settings file under EIGHT_HOME untouched, and settings/path passes", async () => {
		expectIsolated(await runSmoke(true));
	}, 180_000);
});
