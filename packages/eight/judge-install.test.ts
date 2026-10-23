import { afterAll, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	JUDGE_ASK_LINE,
	JUDGE_MODEL,
	JUDGE_OLLAMA_DOWN_LINE,
	JUDGE_UNSUPPORTED_LINE,
	type JudgeChoice,
	type JudgeDeps,
	cleanText,
	configPath,
	judgeAskLine,
	offerJudge,
	pullModel,
	readChoice,
	writeChoice,
} from "./judge-install";

type Opts = {
	judge?: boolean;
	ollama?: "up" | "installed" | "none";
	answer?: boolean | null;
	pullFails?: boolean;
} & Omit<Partial<JudgeDeps>, "ollama">;

function rig(opts: Opts = {}) {
	const { judge, ollama, answer, pullFails, ...extra } = opts;
	const over = { judge, ollama, answer, pullFails };
	const log = {
		said: [] as string[],
		asked: [] as string[],
		pulls: [] as string[],
		progress: [] as string[],
		writes: [] as (JudgeChoice | null)[],
	};
	let installed = over.judge ?? false;
	let stored: JudgeChoice | null = null;
	const deps: JudgeDeps = {
		env: {},
		probe: async () =>
			installed ? { backend: "ollama", model: "selene" } : { backend: "none", model: null },
		ollama: async () => over.ollama ?? "up",
		pull: async (m, on) => {
			log.pulls.push(m);
			if (over.pullFails) throw new Error("disk full");
			on(10);
			on(100);
			installed = true;
		},
		ask: async (l) => {
			log.asked.push(l);
			return over.answer === undefined ? true : over.answer;
		},
		say: (l) => log.said.push(l),
		progress: (l) => log.progress.push(l),
		readChoice: () => stored,
		writeChoice: (c) => {
			log.writes.push(c);
			stored = c;
			return true;
		},
		...extra,
	};
	return { deps, log, stored: () => stored };
}

describe("offerJudge auto (after update, first run)", () => {
	test("judge already installed: asks nothing, installs nothing", async () => {
		const r = rig({ judge: true });
		expect(await offerJudge("auto", r.deps)).toBe("present");
		expect(r.log.asked).toEqual([]);
		expect(r.log.pulls).toEqual([]);
		expect(r.log.said).toEqual([]);
	});

	test("no judge: asks once on one line naming model and size, yes installs with progress and confirms", async () => {
		const r = rig({ answer: true });
		expect(await offerJudge("auto", r.deps)).toBe("installed");
		expect(r.log.asked).toEqual([JUDGE_ASK_LINE]);
		expect(JUDGE_ASK_LINE).toContain(JUDGE_MODEL);
		expect(JUDGE_ASK_LINE).toContain("4.9 GB");
		expect(JUDGE_ASK_LINE.includes("\n")).toBe(false);
		expect(r.log.pulls).toEqual([JUDGE_MODEL]);
		expect(r.log.progress.at(-1)).toContain("100%");
		expect(r.log.said.at(-1)).toStartWith("Safety judge ready");
	});

	test("no: nothing pulled, choice recorded, never asks again", async () => {
		const r = rig({ answer: false });
		expect(await offerJudge("auto", r.deps)).toBe("declined");
		expect(r.log.pulls).toEqual([]);
		expect(r.stored()).toBe("declined");
		expect(await offerJudge("auto", r.deps)).toBe("recorded");
		expect(r.log.asked.length).toBe(1);
	});

	test("nobody to ask: no install, nothing recorded", async () => {
		const r = rig({ answer: null });
		expect(await offerJudge("auto", r.deps)).toBe("no-person");
		expect(r.log.pulls).toEqual([]);
		expect(r.stored()).toBeNull();
	});

	test("unsupported platform (no Ollama): no offer, says rules only once, never nags", async () => {
		const r = rig({ ollama: "none" });
		expect(await offerJudge("auto", r.deps)).toBe("unsupported");
		expect(r.log.asked).toEqual([]);
		expect(r.log.pulls).toEqual([]);
		expect(r.log.said).toEqual([JUDGE_UNSUPPORTED_LINE]);
		expect(JUDGE_UNSUPPORTED_LINE).toContain("/judge install");
		expect(await offerJudge("auto", r.deps)).toBe("recorded");
		expect(r.log.said.length).toBe(1);
	});

	test("Ollama installed but not running: explains how to start it, no offer", async () => {
		const r = rig({ ollama: "installed" });
		expect(await offerJudge("auto", r.deps)).toBe("unsupported");
		expect(r.log.said).toEqual([JUDGE_OLLAMA_DOWN_LINE]);
		expect(r.log.pulls).toEqual([]);
	});

	test("install fails: says so, records failed, does not ask again", async () => {
		const r = rig({ answer: true, pullFails: true });
		expect(await offerJudge("auto", r.deps)).toBe("failed");
		expect(r.log.said.at(-1)).toContain("disk full");
		expect(r.log.said.at(-1)).toContain("/judge install");
		expect(r.stored()).toBe("failed");
		expect(await offerJudge("auto", r.deps)).toBe("recorded");
		expect(r.log.asked.length).toBe(1);
	});

	test("pull finishes but no judge answers: counts as a failure", async () => {
		const r = rig({
			answer: true,
			probe: async () => ({ backend: "none", model: null }),
			pull: async () => {},
		});
		expect(await offerJudge("auto", r.deps)).toBe("failed");
	});

	test("EIGHT_SYSTEM_ONE=0: System One is off, nothing asked", async () => {
		const r = rig({ env: { EIGHT_SYSTEM_ONE: "0" } });
		expect(await offerJudge("auto", r.deps)).toBe("off");
		expect(r.log.asked).toEqual([]);
	});
});

describe("offerJudge command (/judge install)", () => {
	test("installs without a second question and clears an earlier no", async () => {
		const r = rig();
		r.deps.writeChoice?.("declined");
		expect(await offerJudge("command", r.deps)).toBe("installed");
		expect(r.log.asked).toEqual([]);
		expect(r.stored()).toBeNull();
	});

	test("already installed: says so", async () => {
		const r = rig({ judge: true });
		expect(await offerJudge("command", r.deps)).toBe("present");
		expect(r.log.said[0]).toContain("already installed");
	});

	test("unsupported: says it every time it is asked", async () => {
		const r = rig({ ollama: "none" });
		await offerJudge("command", r.deps);
		await offerJudge("command", r.deps);
		expect(r.log.said).toEqual([JUDGE_UNSUPPORTED_LINE, JUDGE_UNSUPPORTED_LINE]);
		expect(r.log.pulls).toEqual([]);
	});

	test("failure is not recorded as a never-ask", async () => {
		const r = rig({ pullFails: true });
		expect(await offerJudge("command", r.deps)).toBe("failed");
		expect(r.stored()).toBeNull();
	});
});

describe("config record", () => {
	const dirs: string[] = [];
	const home = () => {
		const d = mkdtempSync(join(tmpdir(), "judge-cfg-"));
		dirs.push(d);
		return d;
	};
	afterAll(() => {
		for (const d of dirs) rmSync(d, { recursive: true, force: true });
	});

	test("keeps other keys, round-trips, and clears", () => {
		const env = { EIGHT_HOME: home() };
		expect(readChoice(env)).toBeNull();
		writeChoice("declined", env);
		expect(readChoice(env)).toBe("declined");
		const p = configPath(env);
		const j = JSON.parse(readFileSync(p, "utf-8"));
		writeFileSync(p, JSON.stringify({ ...j, model: "keep-me" }));
		writeChoice("failed", env);
		expect(JSON.parse(readFileSync(p, "utf-8")).model).toBe("keep-me");
		writeChoice(null, env);
		expect(readChoice(env)).toBeNull();
		expect(JSON.parse(readFileSync(p, "utf-8")).model).toBe("keep-me");
	});

	test("a config that does not parse is never overwritten and never asked about", () => {
		const env = { EIGHT_HOME: home() };
		const p = configPath(env);
		writeChoice("declined", env);
		writeFileSync(p, "{ not json");
		expect(writeChoice("declined", env)).toBe(false);
		expect(readFileSync(p, "utf-8")).toBe("{ not json");
		expect(readChoice(env)).toBe("corrupt");
		expect(existsSync(p)).toBe(true);
	});
});

describe("config write safety", () => {
	const dirs: string[] = [];
	const home = () => {
		const d = mkdtempSync(join(tmpdir(), "judge-sym-"));
		dirs.push(d);
		return d;
	};
	afterAll(() => {
		for (const d of dirs) rmSync(d, { recursive: true, force: true });
	});

	test("a symlinked config stays a symlink and the real target is updated in place", () => {
		const h = home();
		const real = join(h, "dotfiles", "config.json");
		mkdirSync(join(h, "dotfiles"));
		writeFileSync(real, JSON.stringify({ key: "secret" }), { mode: 0o600 });
		chmodSync(real, 0o600);
		mkdirSync(join(h, ".8gent"));
		symlinkSync(real, join(h, ".8gent", "config.json"));
		const env = { EIGHT_HOME: h };
		expect(writeChoice("declined", env)).toBe(true);
		expect(lstatSync(configPath(env)).isSymbolicLink()).toBe(true);
		const j = JSON.parse(readFileSync(real, "utf-8"));
		expect(j.key).toBe("secret");
		expect(j.judgeInstall.choice).toBe("declined");
		expect(statSync(real).mode & 0o777).toBe(0o600);
		expect(readdirSync(join(h, "dotfiles"))).toEqual(["config.json"]);
	});

	test("an existing mode is kept, a new file is 0600", () => {
		const h = home();
		const env = { EIGHT_HOME: h };
		writeChoice("declined", env);
		expect(statSync(configPath(env)).mode & 0o777).toBe(0o600);
		chmodSync(configPath(env), 0o640);
		writeChoice("failed", env);
		expect(statSync(configPath(env)).mode & 0o777).toBe(0o640);
	});
});

describe("cleanText", () => {
	test("strips escape and control characters and caps length", () => {
		expect(cleanText("bad\x1b[2J\x07 thing\r\nnext")).toBe("bad [2J thing next");
		expect(cleanText("x".repeat(500)).length).toBe(200);
	});
});

describe("pullModel", () => {
	const enc = new TextEncoder();
	const streamOf = (chunks: string[], stall = false) =>
		new Response(
			new ReadableStream({
				start(c) {
					for (const x of chunks) c.enqueue(enc.encode(x));
					if (!stall) c.close();
				},
			}),
		);

	test("reports percent and succeeds on success", async () => {
		const pct: number[] = [];
		await pullModel(
			async () => streamOf(['{"total":100,"completed":50}\n{"status":"success"}\n']),
			"http://h",
			"m",
			(n) => pct.push(n),
		);
		expect(pct).toEqual([50]);
	});

	test("an error line is printed clean", async () => {
		await expect(
			pullModel(
				async () => streamOf(['{"error":"boom\\u001b[31m red"}\n']),
				"http://h",
				"m",
				() => {},
			),
		).rejects.toThrow("boom [31m red");
	});

	test("no bytes for the idle window fails cleanly", async () => {
		const f = (_u: string, init?: RequestInit) => {
			const res = streamOf(['{"total":100,"completed":1}\n'], true);
			init?.signal?.addEventListener("abort", () => {});
			return Promise.resolve(res);
		};
		await expect(pullModel(f, "http://h", "m", () => {}, 40)).rejects.toThrow("nothing for");
	});
});

describe("update path default is No", () => {
	test("defaultYes false shows [y/N] and passes it to the prompt", async () => {
		const r = rig();
		let seen = null as [string, boolean] | null;
		r.deps.defaultYes = false;
		r.deps.ask = async (l, d) => {
			seen = [l, d];
			return d; // a bare Enter answers the default
		};
		expect(await offerJudge("auto", r.deps)).toBe("declined");
		expect(seen?.[0]).toEndWith("[y/N]");
		expect(seen?.[1]).toBe(false);
		expect(r.log.pulls).toEqual([]);
		expect(judgeAskLine(true)).toEndWith("[Y/n]");
	});
});
