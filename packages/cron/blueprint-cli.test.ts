import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Drives `8gent blueprint` as a real process with a temp HOME. The command
// only lists and saves, so no agent or model is started.
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
		expect(cli(["list"]).err).toContain("Blueprints are off");
		expect(fs.existsSync(store())).toBe(false);
	});

	test("flag on: add saves exactly one routine and says nothing runs it", () => {
		const r = cli(["add", "pr-watch", "repo=owner/repo", "every=6h"], "1");
		expect(r.code).toBe(0);
		expect(r.out).toContain("Saved routine");
		expect(r.out).toContain("Nothing runs routines yet; this trial only saves them.");
		expect(r.out).not.toContain("blueprint run");
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

	test("flag on: parser refuses a repeated key, __proto__ and a bare word, escaped", () => {
		const twice = cli(["add", "morning-brief", "time=07:00", "time=08:00"], "1");
		expect(twice.code).not.toBe(0);
		expect(twice.err).toContain('Slot given twice: "time"');
		const proto = cli(["add", "morning-brief", "__proto__=x"], "1");
		expect(proto.code).not.toBe(0);
		expect(proto.err).toContain('Not a slot name: "__proto__"');
		const bare = cli(["add", "morning-brief", "oops\u001b[2J"], "1");
		expect(bare.code).not.toBe(0);
		expect(bare.err).toContain('Expected key=value, got "oops\\u001b[2J"');
		expect(fs.existsSync(store())).toBe(false);
	});

	test("flag on: there is no run subcommand", () => {
		const r = cli(["run", "abcd1234"], "1");
		expect(r.code).not.toBe(0);
		expect(r.err).toContain("Usage: 8gent blueprint list | add <name> key=value...");
	});

	test("flag on: list shows the three blueprints", () => {
		const r = cli(["list"], "1");
		expect(r.code).toBe(0);
		for (const n of ["morning-brief", "pr-watch", "weekly-review"]) expect(r.out).toContain(n);
	});
});
