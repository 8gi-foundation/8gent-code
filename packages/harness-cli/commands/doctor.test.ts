/**
 * doctor: tiered output behind EIGHT_DOCTOR_TIERS=1 (#3451), and the
 * flag-off output pinned byte for byte to what doctor printed before.
 *
 * Isolation (#3394): every run gets its own temp home, a stubbed fetch, stubbed
 * module loaders and an explicit env, so doctor never reads the real ~/.8gent,
 * never touches the network and never sees a real credential.
 */

import { afterAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CHECK_META, type CheckName, type DoctorDeps, TIER_ORDER, doctor } from "./doctor.js";

const GOLDEN = JSON.parse(
	fs.readFileSync(path.join(import.meta.dir, "__fixtures__", "doctor-flag-off.json"), "utf8"),
) as Record<string, string[]>;

const homes: string[] = [];
afterAll(() => {
	for (const h of homes) fs.rmSync(h, { recursive: true, force: true });
});

type Scenario = "down" | "up" | "http" | "importfail";

function depsFor(scenario: Scenario, flag: boolean): DoctorDeps {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-3451-"));
	homes.push(home);
	const env: Record<string, string | undefined> = flag ? { EIGHT_DOCTOR_TIERS: "1" } : {};
	const deps: DoctorDeps = {
		home,
		env,
		loadAgent: async () => ({ Agent: class {} }),
		loadTools: async () => ({ agentTools: { a: 1, b: 2, c: 3 } }),
	};
	if (scenario === "down") {
		deps.fetch = async () => {
			throw new Error("ECONNREFUSED");
		};
	} else if (scenario === "up") {
		const s = path.join(home, ".8gent", "sessions");
		fs.mkdirSync(s, { recursive: true });
		for (const f of ["a.jsonl", "b.jsonl", "notes.txt"]) fs.writeFileSync(path.join(s, f), "");
		env.OPENROUTER_API_KEY = "sk-or-v1-FAKE-test-only";
		deps.fetch = async (u: string) =>
			u.includes("11434")
				? new Response(JSON.stringify({ models: [{ name: "qwen3:8b" }, { name: "llama3:8b" }] }), {
						status: 200,
					})
				: new Response("{}", { status: 200 });
	} else {
		deps.fetch = async () => new Response("no", { status: 503 });
		if (scenario === "importfail") {
			deps.loadAgent = async () => {
				throw new Error("agent boom");
			};
			deps.loadTools = async () => {
				throw new Error("tools boom");
			};
		}
	}
	return deps;
}

async function run(scenario: Scenario, flag: boolean): Promise<string[]> {
	const deps = depsFor(scenario, flag);
	const lines: string[] = [];
	const original = console.log;
	console.log = (...a: unknown[]) => {
		lines.push(a.map(String).join(" "));
	};
	try {
		await doctor([], deps);
	} finally {
		console.log = original;
	}
	return lines.map((l) => l.split(deps.home as string).join("<HOME>"));
}

const ALL: CheckName[] = [
	"Sessions directory",
	"Existing sessions",
	"Ollama",
	"LM Studio",
	"OpenRouter API key",
	"Agent module",
	"AI SDK tools",
];
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const strip = (l: string) => l.replace(ANSI, "");

describe("doctor flag off: output unchanged from before #3451", () => {
	for (const scenario of ["down", "up", "http", "importfail"] as const) {
		it(`matches the captured output (${scenario})`, async () => {
			expect(await run(scenario, false)).toEqual(GOLDEN[scenario]);
		});
	}

	it("any value other than 1 leaves the flag off", async () => {
		const deps = depsFor("down", false);
		(deps.env as Record<string, string>).EIGHT_DOCTOR_TIERS = "true";
		const lines: string[] = [];
		const original = console.log;
		console.log = (...a: unknown[]) => lines.push(a.map(String).join(" "));
		try {
			await doctor([], deps);
		} finally {
			console.log = original;
		}
		expect(lines.map((l) => l.split(deps.home as string).join("<HOME>"))).toEqual(GOLDEN.down);
	});
});

describe("doctor check metadata", () => {
	it("every check has a tier, a layer and a one-line fix", () => {
		expect(Object.keys(CHECK_META).sort()).toEqual([...ALL].sort());
		for (const name of ALL) {
			const m = CHECK_META[name];
			expect(TIER_ORDER).toContain(m.tier);
			expect(["sessions", "providers", "credentials", "runtime", "tools"]).toContain(m.layer);
			expect(m.fix.trim().length).toBeGreaterThan(0);
			expect(m.fix).not.toContain("\n");
		}
	});

	it("every check doctor actually emits is covered", async () => {
		const seen = new Set<string>();
		for (const s of ["down", "up", "importfail"] as const) {
			for (const l of await run(s, false)) {
				const m = strip(l).match(/^ {2}[✓✗] (.{22}) /);
				if (m) seen.add(m[1].trim());
			}
		}
		expect([...seen].sort()).toEqual([...ALL].sort());
	});
});

describe("doctor flag on: tiered report", () => {
	it("groups critical, then structural, then hygiene, each check once", async () => {
		const lines = (await run("down", true)).map(strip);
		const headers = lines.filter((l) => /^ {2}[A-Z]+$/.test(l)).map((l) => l.trim());
		expect(headers).toEqual(["CRITICAL", "STRUCTURAL", "HYGIENE"]);
		const order: string[] = [];
		let current = "";
		for (const l of lines) {
			if (/^ {2}[A-Z]+$/.test(l)) current = l.trim().toLowerCase();
			const m = l.match(/^ {2}[✓✗] (.{22}) /);
			if (m) {
				const name = m[1].trim() as CheckName;
				expect(CHECK_META[name].tier).toBe(current as never);
				order.push(name);
			}
		}
		expect([...order].sort()).toEqual(ALL.filter((n) => n !== "Existing sessions").sort());
	});

	it("prints the layer on each line and the fix under each failing check only", async () => {
		const lines = (await run("importfail", true)).map(strip);
		for (const name of [
			"Sessions directory",
			"Ollama",
			"LM Studio",
			"OpenRouter API key",
			"Agent module",
			"AI SDK tools",
		] as const) {
			const i = lines.findIndex((l) =>
				l.startsWith(`  ✗ ${name.padEnd(22)} [${CHECK_META[name].layer}] `),
			);
			expect(i).toBeGreaterThan(-1);
			expect(lines[i + 1]).toBe(`      fix: ${CHECK_META[name].fix}`);
		}
		expect(lines.at(-1)).toBe(
			"  6 failing: 3 critical, 1 structural, 2 hygiene. Fix critical first.\n",
		);
	});

	it("prints no fix lines and no key prefix when everything passes", async () => {
		const lines = (await run("up", true)).map(strip);
		expect(lines.some((l) => l.includes("fix:"))).toBe(false);
		expect(lines.join("\n")).not.toContain("sk-or-v1");
		expect(lines.find((l) => l.includes("OpenRouter API key"))).toBe(
			"  ✓ OpenRouter API key     [credentials] Set",
		);
		expect(lines.at(-1)).toBe("  All checks passed.\n");
	});
});
