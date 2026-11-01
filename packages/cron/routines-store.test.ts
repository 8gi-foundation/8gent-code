import { afterAll, describe, expect, setSystemTime, test } from "bun:test";
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

describe("routines store: hardening from the second read", () => {
	test("an existing 0755 data directory is tightened to 0700 on load, not only one the store creates", () => {
		const home = dir();
		mkdirSync(join(home, ".8gent"), { recursive: true });
		chmodSync(join(home, ".8gent"), 0o755);
		writeFileSync(storeOf(home), "[]");
		new RoutineManager(undefined, { EIGHT_HOME: home });
		expect(mode(join(home, ".8gent"))).toBe(0o700);
	});

	test("and on a store that does not exist yet, and again on save", () => {
		const home = dir();
		mkdirSync(join(home, ".8gent"), { recursive: true });
		chmodSync(join(home, ".8gent"), 0o755);
		const m = new RoutineManager(undefined, { EIGHT_HOME: home });
		expect(mode(join(home, ".8gent"))).toBe(0o700);
		chmodSync(join(home, ".8gent"), 0o755);
		m.create(make);
		expect(mode(join(home, ".8gent"))).toBe(0o700);
	});

	test("a directory the caller named with an explicit path is left as it is", () => {
		const d = dir();
		chmodSync(d, 0o755);
		new RoutineManager(join(d, "r.json"), { EIGHT_HOME: "/elsewhere" }).create(make);
		expect(mode(d)).toBe(0o755);
	});

	test("a move-aside never clobbers an earlier backup of the same name", () => {
		const home = dir();
		const env = { EIGHT_HOME: home };
		const frozen = new Date("2026-10-24T10:30:00.000Z");
		setSystemTime(frozen);
		try {
			mkdirSync(join(home, ".8gent"), { recursive: true });
			const first = `${storeOf(home)}.corrupt-${frozen.toISOString().replace(/[:.]/g, "-")}`;
			writeFileSync(first, "EARLIER BACKUP");
			writeFileSync(storeOf(home), "{second corruption");
			new RoutineManager(undefined, env);
			const copies = readdirSync(join(home, ".8gent")).filter((n) => n.includes(".corrupt-"));
			expect(copies.length).toBe(2);
			expect(readFileSync(first, "utf-8")).toBe("EARLIER BACKUP");
			const other = copies.find((n) => join(home, ".8gent", n) !== first) as string;
			expect(readFileSync(join(home, ".8gent", other), "utf-8")).toBe("{second corruption");
			expect(mode(join(home, ".8gent", other))).toBe(0o600);
			expect(existsSync(storeOf(home))).toBe(false);
		} finally {
			setSystemTime();
		}
	});

	test("many corruptions in the same instant keep every copy", () => {
		const home = dir();
		const env = { EIGHT_HOME: home };
		setSystemTime(new Date("2026-10-24T10:31:00.000Z"));
		try {
			mkdirSync(join(home, ".8gent"), { recursive: true });
			for (let i = 0; i < 4; i++) {
				writeFileSync(storeOf(home), `{bad ${i}`);
				new RoutineManager(undefined, env);
			}
			const bodies = readdirSync(join(home, ".8gent"))
				.filter((n) => n.includes(".corrupt-"))
				.map((n) => readFileSync(join(home, ".8gent", n), "utf-8"))
				.sort();
			expect(bodies).toEqual(["{bad 0", "{bad 1", "{bad 2", "{bad 3"]);
		} finally {
			setSystemTime();
		}
	});

	test("a failed rename removes its temp file", () => {
		const home = dir();
		const m = new RoutineManager(undefined, { EIGHT_HOME: home });
		// A non-empty directory where the store should be: renaming a file over it fails.
		mkdirSync(storeOf(home), { recursive: true });
		writeFileSync(join(storeOf(home), "x"), "x");
		expect(() => m.create(make)).toThrow();
		expect(readdirSync(join(home, ".8gent"))).toEqual(["routines.json"]);
	});
});
