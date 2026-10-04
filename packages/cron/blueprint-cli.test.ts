import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Drives `8gent blueprint` as a real process with a temp HOME. Never calls
// `run` on a saved routine, so no agent or model is started.
const BIN = path.join(import.meta.dir, "..", "..", "bin", "8gent.ts");
let home: string;

beforeEach(() => {
	home = fs.mkdtempSync(path.join(os.tmpdir(), "blueprint-cli-"));
});
afterEach(() => {
	fs.rmSync(home, { recursive: true, force: true });
});

function cli(args: string[], flag?: string) {
	const env: Record<string, string> = { ...process.env, HOME: home, TMPDIR: home } as Record<string, string>;
	delete env.EIGHT_HOME;
	delete env.EIGHT_BLUEPRINTS;
	if (flag !== undefined) env.EIGHT_BLUEPRINTS = flag;
	const p = Bun.spawnSync([process.execPath, BIN, "blueprint", ...args], { env, cwd: home });
	return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

const store = () => path.join(home, ".8gent", "routines.json");

describe("8gent blueprint", () => {
	test("flag off: refuses and writes nothing", () => {
		for (const flag of [undefined, "0", "true"]) {
			const r = cli(["add", "morning-brief", "time=07:00"], flag);
			expect(r.code).not.toBe(0);
			expect(r.err).toContain("Blueprints are off");
		}
		expect(cli(["run", "abcd1234"]).err).toContain("Blueprints are off");
		expect(fs.existsSync(store())).toBe(false);
	});

	test("flag on: add saves exactly one routine and says nothing runs it yet", () => {
		const r = cli(["add", "pr-watch", "repo=owner/repo", "every=6h"], "1");
		expect(r.code).toBe(0);
		expect(r.out).toContain("Saved routine");
		expect(r.out).toContain("Nothing runs routines automatically yet.");
		expect(r.out).toContain("8gent blueprint run ");
		expect(r.out.toLowerCase()).not.toContain("scheduled");
		const saved = JSON.parse(fs.readFileSync(store(), "utf-8"));
		expect(saved).toHaveLength(1);
		expect(saved[0].schedule).toBe("0 */6 * * 1,2,3,4,5");
	});

	test("flag on: a bad slot is refused with a message and non-zero exit", () => {
		const r = cli(["add", "morning-brief", "time=25:00"], "1");
		expect(r.code).not.toBe(0);
		expect(r.err).toContain('slot "time" must be HH:MM');
		expect(fs.existsSync(store())).toBe(false);
	});

	test("flag on: run with an unknown id refuses", () => {
		const r = cli(["run", "nope0000"], "1");
		expect(r.code).not.toBe(0);
		expect(r.err).toContain("No saved routine with id nope0000");
	});

	test("flag on: list shows the three blueprints", () => {
		const r = cli(["list"], "1");
		expect(r.code).toBe(0);
		for (const n of ["morning-brief", "pr-watch", "weekly-review"]) expect(r.out).toContain(n);
	});
});
