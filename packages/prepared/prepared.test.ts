import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { approve, listQueue, markLanded, reject } from "./apply.js";
import { preparedCommand } from "./cli.js";
import {
	assertLocalUrl,
	deterministicDrafter,
	drafterFromEnv,
	modelDrafter,
	runPass,
	shouldRunIdle,
} from "./pass.js";
import { rank } from "./rank.js";
import { PreparedWriteDenied } from "./store.js";
import { cand, diffDrafter, fixture, sh } from "./testkit.js";

const NOW = new Date("2026-10-27T20:00:00");

describe("safety: the pass writes only inside the prepared dir", () => {
	test("PreparedIO refuses paths outside the dir, dot-dot and symlink tunnels", () => {
		const { io, root, dir } = fixture();
		io.write("ok.json", "{}");
		expect(fs.existsSync(path.join(dir, "ok.json"))).toBe(true);
		expect(() => io.write(path.join(root, "outside.txt"), "x")).toThrow(PreparedWriteDenied);
		expect(() => io.write("../escape.txt", "x")).toThrow(PreparedWriteDenied);
		expect(() => io.append(path.join(io.workspace, "a.txt"), "x")).toThrow(PreparedWriteDenied);
		const out = path.join(root, "elsewhere");
		fs.mkdirSync(out);
		fs.symlinkSync(out, path.join(dir, "tunnel"));
		expect(() => io.write("tunnel/pwn.txt", "x")).toThrow(PreparedWriteDenied);
		expect(fs.existsSync(path.join(out, "pwn.txt"))).toBe(false);
		expect(() => io.read(path.join(root, "home", "secret"))).toThrow(PreparedWriteDenied);
	});

	test("a whole pass leaves the workspace byte for byte unchanged", async () => {
		const { io, ws, dir } = fixture();
		fs.writeFileSync(path.join(ws, "old.ts"), "// TODO: handle the empty list case here\n");
		fs.utimesSync(path.join(ws, "old.ts"), new Date("2026-01-01"), new Date("2026-01-01"));
		sh(ws, "git add -A && git commit -q -m todo");
		const snap = () =>
			sh(ws, "find . -path ./.git -prune -o -type f -print0 | xargs -0 shasum | sort");
		const before = snap();
		const r = await runPass(io, { now: NOW, rng: () => 0.1 });
		expect(r.prepared.length).toBe(1);
		expect(snap()).toBe(before);
		expect(sh(ws, "git status --porcelain")).toBe("");
		expect(fs.readdirSync(dir).some((f) => f.endsWith(".json"))).toBe(true);
	});
});

describe("nothing executes without approve", () => {
	test("pass and list run nothing; approve runs the stored command once", async () => {
		const { io, ws, dir, diffFor } = fixture();
		const calls: string[] = [];
		const run = (c: string) => {
			calls.push(c);
			return { code: 0, output: "" };
		};
		const r = await runPass(io, {
			now: NOW,
			candidates: [cand(1)],
			drafter: diffDrafter(diffFor("b.txt")),
		});
		listQueue(io, { now: NOW });
		expect(calls.length).toBe(0);
		expect(fs.existsSync(path.join(dir, "worktrees"))).toBe(false);
		expect(sh(ws, "git branch --list 'prepared/*'")).toBe("");
		const res = approve(io, r.prepared[0], { now: NOW, run });
		expect(calls.length).toBe(1);
		expect(res.status).toBe("approved");
		expect(calls[0]).toBe(io.loadPacket(r.prepared[0])!.apply);
	});

	test("real path: approve applies the diff in a worktree and runs the gate", async () => {
		const { io, ws, dir, diffFor, setGate } = fixture();
		setGate("test -f b.txt");
		const r = await runPass(io, {
			now: NOW,
			candidates: [cand(2)],
			drafter: diffDrafter(diffFor("b.txt", "two")),
		});
		const id = r.prepared[0];
		const res = approve(io, id, { now: NOW });
		expect(res.gate).toBe("pass");
		expect(fs.readFileSync(path.join(dir, "worktrees", id, "b.txt"), "utf8")).toBe("two\n");
		expect(fs.existsSync(path.join(ws, "b.txt"))).toBe(false);
		expect(sh(ws, "git branch --list 'prepared/*'")).toContain(`prepared/${id}`);
	});

	test("a red gate is recorded as fail and cannot land", async () => {
		const { io, diffFor, setGate } = fixture();
		setGate("false");
		const r = await runPass(io, {
			now: NOW,
			candidates: [cand(3)],
			drafter: diffDrafter(diffFor("c.txt")),
		});
		expect(approve(io, r.prepared[0], { now: NOW }).gate).toBe("fail");
		expect(markLanded(io, r.prepared[0], NOW).reason).toContain("only an approved");
	});
});

describe("ledger schema", () => {
	test("every event carries ts, event, id, confidence, arm; the lifecycle is complete", async () => {
		const { io, diffFor } = fixture();
		await runPass(io, {
			now: NOW,
			rng: () => 0.9,
			candidates: [cand(1), cand(2, "Other work on parsing")],
			drafter: diffDrafter(diffFor("d.txt")),
		});
		// both candidates share one diff, so they are one packet; add a second, distinct one
		await runPass(io, {
			now: NOW,
			candidates: [cand(5, "Document sqlite migration order")],
			drafter: deterministicDrafter,
		});
		const [a, b] = listQueue(io, { now: NOW });
		approve(io, a.id, { now: NOW });
		markLanded(io, a.id, NOW);
		reject(io, b.id, "noise", NOW);
		const events = io.readLedger();
		const names = new Set(events.map((e) => e.event));
		for (const n of ["prepared", "shown", "approved", "rejected", "landed"]) {
			expect(names.has(n as never)).toBe(true);
		}
		for (const e of events) {
			expect(Number.isNaN(Date.parse(e.ts))).toBe(false);
			expect(typeof e.id).toBe("string");
			expect(e.confidence).toBeGreaterThanOrEqual(0);
			expect(e.confidence).toBeLessThanOrEqual(1);
			expect(["profile", "recency"]).toContain(e.arm);
		}
		expect(events.filter((e) => e.event === "shown").map((e) => e.rank)).toEqual([1, 2]);
		expect(events.find((e) => e.event === "rejected")!.reason).toBe("noise");
		expect(events.find((e) => e.event === "approved")!.gate).toBeDefined();
	});

	test("the arm is a random per-day split, stable within a day, and never printed", async () => {
		const f = fixture();
		expect(f.io.armFor(NOW, () => 0.1)).toBe("profile");
		expect(f.io.armFor(NOW, () => 0.9)).toBe("profile");
		const g = fixture();
		expect(g.io.armFor(NOW, () => 0.9)).toBe("recency");
		await runPass(f.io, { now: NOW, candidates: [cand(1)], drafter: deterministicDrafter });
		const lines: string[] = [];
		await preparedCommand(["list"], f.env, (s) => lines.push(s));
		expect(lines.join("\n")).not.toMatch(/profile|recency|arm/);
	});
});

describe("reject feedback changes the ranking", () => {
	test("after a reject, a similar candidate drops below a dissimilar one", async () => {
		const { io } = fixture();
		const p1 = await runPass(io, {
			now: NOW,
			candidates: [cand(1, "Refactor websocket reconnect backoff")],
			drafter: deterministicDrafter,
		});
		await runPass(io, {
			now: NOW,
			candidates: [
				cand(2, "Refactor websocket reconnect timers"),
				cand(3, "Document sqlite migration order"),
			],
			drafter: deterministicDrafter,
		});
		const live = () => io.allPackets().filter((p) => p.status === "prepared");
		const titles = () =>
			rank(live(), "profile", JSON.parse(io.read("profile.json"))).map((p) => p.title);
		const before = titles();
		expect(before.indexOf("Refactor websocket reconnect timers")).toBeLessThan(
			before.indexOf("Document sqlite migration order"),
		);
		reject(io, p1.prepared[0], "websocket work is not my focus", NOW);
		expect(titles()[0]).toBe("Document sqlite migration order");
	});

	test("a near-identical candidate is dropped by the next pass", async () => {
		const { io } = fixture();
		const p1 = await runPass(io, {
			now: NOW,
			candidates: [cand(1, "Refactor websocket reconnect backoff")],
			drafter: deterministicDrafter,
		});
		reject(io, p1.prepared[0], "no", NOW);
		const r = await runPass(io, {
			now: NOW,
			candidates: [cand(9, "Refactor websocket reconnect backoff logic")],
			drafter: deterministicDrafter,
		});
		expect(r.skipped).toBe(1);
		expect(r.prepared.length).toBe(0);
	});

	test("a reject without a reason does nothing", async () => {
		const { io } = fixture();
		const p = await runPass(io, { now: NOW, candidates: [cand(1)], drafter: deterministicDrafter });
		reject(io, p.prepared[0], "  ", NOW);
		expect(io.loadPacket(p.prepared[0])!.status).toBe("prepared");
	});
});

describe("local model by default, no cloud call", () => {
	test("non-loopback endpoints are refused before any request", async () => {
		let calls = 0;
		const spy = (async () => {
			calls++;
			return new Response("{}");
		}) as unknown as typeof fetch;
		expect(() => modelDrafter("https://api.example.com", "m", spy)).toThrow(/not on this machine/);
		expect(() => assertLocalUrl("http://10.0.0.5:11434")).toThrow();
		expect(calls).toBe(0);
		await modelDrafter("http://127.0.0.1:11434", "m", spy)(cand(1), "");
		expect(calls).toBe(1);
	});

	test("with no model configured the pass makes no network call at all", async () => {
		const { io } = fixture();
		const real = globalThis.fetch;
		let calls = 0;
		globalThis.fetch = (async () => {
			calls++;
			return new Response("{}");
		}) as unknown as typeof fetch;
		try {
			await runPass(io, { now: NOW, candidates: [cand(1)], drafter: drafterFromEnv({}) });
		} finally {
			globalThis.fetch = real;
		}
		expect(calls).toBe(0);
	});

	test("idle gate", () => {
		const t = 10_000_000_000;
		expect(shouldRunIdle({ now: t, lastActivity: t - 11 * 60_000, lastPass: 0 })).toBe(true);
		expect(shouldRunIdle({ now: t, lastActivity: t - 60_000, lastPass: 0 })).toBe(false);
		expect(shouldRunIdle({ now: t, lastActivity: 0, lastPass: t - 3_600_000 })).toBe(false);
	});
});
