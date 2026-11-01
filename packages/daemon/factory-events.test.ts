import { afterAll, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emitFactory, validateFactoryEvent } from "./factory-events";

const schema = JSON.parse(
	readFileSync(join(import.meta.dir, "../../docs/specs/factory-events.schema.json"), "utf8"),
);
const dirs: string[] = [];
const tmp = () => {
	const d = mkdtempSync(join(tmpdir(), "factory-events-"));
	dirs.push(d);
	return d;
};
afterAll(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const lines = (f: string) =>
	existsSync(f)
		? readFileSync(f, "utf8")
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((l) => JSON.parse(l))
		: [];

/** Start the real daemon entry point, let it run, stop it. */
async function runDaemon(env: Record<string, string>, ms: number) {
	const data = tmp();
	const proc = Bun.spawn([process.execPath, join(import.meta.dir, "index.ts"), "--local"], {
		env: {
			...process.env,
			EIGHT_DATA_DIR: data,
			EIGHT_DAEMON_PORT: String(20000 + Math.floor(Math.random() * 20000)),
			...env,
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	await Bun.sleep(ms);
	const alive = proc.exitCode === null;
	proc.kill("SIGTERM");
	await Promise.race([proc.exited, Bun.sleep(3000)]);
	if (proc.exitCode === null) proc.kill("SIGKILL");
	return { alive };
}

describe("factory/v1 through the daemon entry point", () => {
	test("a 1 second heartbeat writes valid cell.heartbeat lines", async () => {
		const file = join(tmp(), "8TO.jsonl");
		const { alive } = await runDaemon(
			{ EIGHT_EVENTS_FILE: file, EIGHT_HEARTBEAT_MS: "1000", EIGHT_CELL: "8TO" },
			5000,
		);
		expect(alive).toBe(true);
		const events = lines(file).filter((e) => e.kind === "cell.heartbeat");
		expect(events.length).toBeGreaterThanOrEqual(2);
		for (const e of events) {
			expect(validateFactoryEvent(e, schema)).toEqual([]);
			expect(e.cell).toBe("8TO");
		}
	}, 30_000);

	test("keys in the detail and the cell are scrubbed, and the file is owner-only", async () => {
		const file = join(tmp(), "8TO.jsonl");
		const key = `sk-cp-${"A1b2C3d4".repeat(6)}`;
		const bot = `100000002:AAH${"x1Y2z3W4".repeat(4)}`;
		await runDaemon(
			{
				EIGHT_EVENTS_FILE: file,
				EIGHT_HEARTBEAT_MS: "1000",
				EIGHT_CELL: `8TO ${bot}`,
				EIGHT_CELL_DETAIL: `retry with ${key}`,
			},
			4000,
		);
		const raw = readFileSync(file, "utf8");
		expect(raw).not.toContain(key);
		expect(raw).not.toContain(bot.slice(11));
		expect(raw).toContain("REDACTED");
		expect(statSync(file).mode & 0o077).toBe(0);
	}, 30_000);

	test("with EIGHT_EVENTS_FILE unset nothing is written and the daemon starts", async () => {
		const file = join(tmp(), "none.jsonl");
		const { alive } = await runDaemon({ EIGHT_EVENTS_FILE: "", EIGHT_HEARTBEAT_MS: "1000" }, 3000);
		expect(alive).toBe(true);
		expect(existsSync(file)).toBe(false);
	}, 30_000);
});

const SECRETS = {
	sk: `sk-${"Ab12Cd34".repeat(4)}`,
	skcp: `sk-cp-${"Ab12_Cd3-".repeat(4)}`,
	skant: `sk-ant-api03-${"Ab12Cd34".repeat(6)}`,
	ghp: `ghp_${"Ab12Cd34".repeat(5)}Ab12`,
	bearer: "Authorization: Bearer abcdEFGH1234ijklMNOP5678",
	telegram: `100000002:AAH${"x1Y2z3W4".repeat(4)}`,
};

describe("writer", () => {
	test("every string field is scrubbed for every key shape", () => {
		const file = join(tmp(), "s.jsonl");
		for (const [name, secret] of Object.entries(SECRETS)) {
			const v = `x ${secret} y`;
			emitFactory(
				{ kind: "pr.opened", state: "working", cell: v, repo: v, title: v, sha: v, detail: v },
				{ EIGHT_EVENTS_FILE: file },
			);
			const tail = secret.slice(-12);
			const last = lines(file).at(-1);
			for (const field of ["cell", "repo", "title", "sha", "detail"])
				expect(`${name} ${field} ${last[field]}`).not.toContain(tail);
		}
	});

	test("never writes through a symlink at the log path", () => {
		const dir = tmp();
		const target = join(dir, "victim.txt");
		writeFileSync(target, "keep");
		const file = join(dir, "link.jsonl");
		symlinkSync(target, file);
		expect(
			emitFactory({ kind: "cell.heartbeat", state: "live" }, { EIGHT_EVENTS_FILE: file }),
		).toBe(null);
		expect(readFileSync(target, "utf8")).toBe("keep");
	});

	test("rotates at 10 MB and keeps 3", () => {
		const file = join(tmp(), "r.jsonl");
		const env = { EIGHT_EVENTS_FILE: file };
		for (let i = 0; i < 5; i++) {
			writeFileSync(file, "x".repeat(10 * 1024 * 1024));
			emitFactory({ kind: "cell.heartbeat", state: "live" }, env);
		}
		expect(existsSync(`${file}.3`)).toBe(true);
		expect(existsSync(`${file}.4`)).toBe(false);
		expect(lines(file)).toHaveLength(1);
	});

	test("the validator rejects a bad kind and a long detail", () => {
		const good = {
			v: "factory/v1",
			id: "0".repeat(26),
			at: "2026-10-26T00:00:00Z",
			cell: "8TO",
			kind: "merge.done",
			repo: "",
			number: 1,
			title: "",
			sha: "",
			state: "live",
			detail: "",
		};
		expect(validateFactoryEvent(good, schema)).toEqual([]);
		expect(validateFactoryEvent({ ...good, kind: "nope" }, schema)).not.toEqual([]);
		expect(validateFactoryEvent({ ...good, detail: "y".repeat(141) }, schema)).not.toEqual([]);
	});
});
