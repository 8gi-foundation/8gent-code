import { afterAll, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { RoutineManager, getRoutineManager } from "./routines";

const roots: string[] = [];
const dir = () => {
	const d = mkdtempSync(join(tmpdir(), "routines-store-"));
	roots.push(d);
	return d;
};
afterAll(() => {
	for (const d of roots) {
		try {
			chmodSync(join(d, ".8gent"), 0o700);
		} catch {}
		rmSync(d, { recursive: true, force: true });
	}
});

const make = { name: "n", prompt: "p", schedule: "0 9 * * *" };
const storeOf = (home: string) => join(home, ".8gent", "routines.json");
const mode = (p: string) => statSync(p).mode & 0o777;

describe("routines store: where it lives", () => {
	test("EIGHT_HOME decides, and the real HOME is not touched", () => {
		const eight = dir();
		const realHome = dir();
		const m = new RoutineManager(undefined, { EIGHT_HOME: eight, HOME: realHome });
		m.create(make);
		expect(existsSync(storeOf(eight))).toBe(true);
		expect(existsSync(storeOf(realHome))).toBe(false);
		expect(m.storePath).toBe(storeOf(eight));
	});

	test("the singleton, built from the process env, honours EIGHT_HOME too", () => {
		const eight = dir();
		const was = process.env.EIGHT_HOME;
		process.env.EIGHT_HOME = eight;
		try {
			getRoutineManager().create(make);
			expect(existsSync(storeOf(eight))).toBe(true);
		} finally {
			if (was === undefined) Reflect.deleteProperty(process.env, "EIGHT_HOME");
			else process.env.EIGHT_HOME = was;
		}
	});

	test("no HOME at all: the OS home directory, never a literal ./~ under the working directory", () => {
		const cwd = process.cwd();
		const work = dir();
		process.chdir(work);
		try {
			const m = new RoutineManager(undefined, {});
			expect(m.storePath).toBe(join(homedir(), ".8gent", "routines.json"));
			expect(m.storePath.startsWith(work)).toBe(false);
			expect(existsSync(join(work, "~"))).toBe(false);
			expect(readdirSync(work)).toEqual([]);
		} finally {
			process.chdir(cwd);
		}
	});

	test("an explicit path still wins (callers and tests that pass one)", () => {
		const d = dir();
		const p = join(d, "x", "r.json");
		const m = new RoutineManager(p, { EIGHT_HOME: "/elsewhere" });
		m.create(make);
		expect(existsSync(p)).toBe(true);
		expect(m.storePath).toBe(p);
	});
});

describe("routines store: private, atomic", () => {
	test("a new store is 0600 and its directory 0700", () => {
		const home = dir();
		new RoutineManager(undefined, { EIGHT_HOME: home }).create(make);
		expect(mode(storeOf(home))).toBe(0o600);
		expect(mode(join(home, ".8gent"))).toBe(0o700);
	});

	test("an existing 0644 store is tightened to 0600, on load and on save", () => {
		const home = dir();
		mkdirSync(join(home, ".8gent"), { recursive: true });
		writeFileSync(storeOf(home), "[]", { mode: 0o644 });
		chmodSync(storeOf(home), 0o644);
		const m = new RoutineManager(undefined, { EIGHT_HOME: home });
		expect(mode(storeOf(home))).toBe(0o600);
		chmodSync(storeOf(home), 0o644);
		m.create(make);
		expect(mode(storeOf(home))).toBe(0o600);
	});

	test("a save leaves exactly one file behind, and the routines round-trip", () => {
		const home = dir();
		const env = { EIGHT_HOME: home };
		const r = new RoutineManager(undefined, env).create(make);
		expect(readdirSync(join(home, ".8gent"))).toEqual(["routines.json"]);
		expect(new RoutineManager(undefined, env).get(r.id)?.name).toBe("n");
	});

	test("a symlinked store is replaced, never written through to its target", () => {
		const home = dir();
		const victim = join(home, "victim.txt");
		writeFileSync(victim, "keep");
		mkdirSync(join(home, ".8gent"), { recursive: true });
		symlinkSync(victim, storeOf(home));
		new RoutineManager(undefined, { EIGHT_HOME: home }).create(make);
		expect(readFileSync(victim, "utf-8")).toBe("keep");
		expect(statSync(storeOf(home)).isFile()).toBe(true);
	});
});

describe("routines store: a corrupt file is never overwritten", () => {
	const corruptCopies = (home: string) =>
		readdirSync(join(home, ".8gent")).filter((n) => n.startsWith("routines.json.corrupt-"));

	for (const [label, bytes] of [
		["truncated JSON", '[{"id":"a1","name":"half'],
		["not an array", '{"routines":[]}'],
		["empty file", ""],
	] as const) {
		test(`${label}: kept as a 0600 backup, then a fresh store; the original bytes survive the next save`, () => {
			const home = dir();
			const env = { EIGHT_HOME: home };
			mkdirSync(join(home, ".8gent"), { recursive: true });
			writeFileSync(storeOf(home), bytes);
			const m = new RoutineManager(undefined, env);
			expect(m.list()).toEqual([]);
			const [backup] = corruptCopies(home);
			expect(backup).toBeDefined();
			expect(readFileSync(join(home, ".8gent", backup), "utf-8")).toBe(bytes);
			expect(mode(join(home, ".8gent", backup))).toBe(0o600);
			m.create(make);
			expect(readFileSync(join(home, ".8gent", backup), "utf-8")).toBe(bytes);
			expect(new RoutineManager(undefined, env).list().length).toBe(1);
		});
	}

	test("a backup that cannot be made refuses to start, and the file is untouched", () => {
		const home = dir();
		mkdirSync(join(home, ".8gent"), { recursive: true });
		writeFileSync(storeOf(home), "{broken");
		chmodSync(join(home, ".8gent"), 0o500);
		try {
			expect(() => new RoutineManager(undefined, { EIGHT_HOME: home })).toThrow(/routines/i);
			expect(readFileSync(storeOf(home), "utf-8")).toBe("{broken");
		} finally {
			chmodSync(join(home, ".8gent"), 0o700);
		}
	});

	test("a good file is not touched at load", () => {
		const home = dir();
		const env = { EIGHT_HOME: home };
		new RoutineManager(undefined, env).create(make);
		const before = readFileSync(storeOf(home), "utf-8");
		new RoutineManager(undefined, env);
		expect(readFileSync(storeOf(home), "utf-8")).toBe(before);
		expect(corruptCopies(home)).toEqual([]);
	});
});
