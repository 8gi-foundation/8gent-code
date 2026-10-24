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
	llamaAskLine,
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
	startFails?: boolean;
} & Omit<Partial<JudgeDeps>, "ollama">;

function rig(opts: Opts = {}) {
	const { judge, ollama, answer, pullFails, startFails, ...extra } = opts;
	const over = { judge, ollama, answer, pullFails, startFails };
	const log = {
		said: [] as string[],
		asked: [] as string[],
		pulls: [] as string[],
		starts: 0,
		progress: [] as string[],
		writes: [] as (JudgeChoice | null)[],
	};
	let installed = over.judge ?? false;
	let ollamaUp = false;
	let stored: JudgeChoice | null = null;
	const deps: JudgeDeps = {
		env: {},
		probe: async () =>
			installed ? { backend: "ollama", model: "selene" } : { backend: "none", model: null },
		ollama: async () => (ollamaUp ? "up" : (over.ollama ?? "up")),
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
		// Never the real one: a test must not start a server on the machine running it.
		startOllama: async () => {
			log.starts++;
			if (over.startFails) return { ok: false, line: "Ollama did not answer within 10 s." };
			ollamaUp = true;
			return { ok: true, how: "spawn" };
		},
		llama: { enabled: false },
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

	test("Ollama installed but not running: asks once to start it, a no explains and never asks again", async () => {
		const r = rig({ ollama: "installed", answer: false });
		expect(await offerJudge("auto", r.deps)).toBe("unsupported");
		expect(r.log.asked).toEqual(["Start Ollama in the background now? [Y/n]"]);
		expect(r.log.starts).toBe(0);
		expect(r.log.said).toEqual([JUDGE_OLLAMA_DOWN_LINE]);
		expect(r.log.pulls).toEqual([]);
		expect(await offerJudge("auto", r.deps)).toBe("recorded");
		expect(r.log.asked.length).toBe(1);
	});

	test("Ollama installed but not running: yes starts it, then the judge question follows", async () => {
		const r = rig({ ollama: "installed", answer: true });
		expect(await offerJudge("auto", r.deps)).toBe("installed");
		expect(r.log.starts).toBe(1);
		expect(r.log.asked).toEqual(["Start Ollama in the background now? [Y/n]", judgeAskLine(true)]);
		expect(r.log.said[0]).toBe("Starting Ollama in the background.");
		expect(r.log.pulls).toEqual([JUDGE_MODEL]);
	});

	test("Ollama does not come up: one plain line, the down line is not repeated", async () => {
		const r = rig({ ollama: "installed", answer: true, startFails: true });
		expect(await offerJudge("auto", r.deps)).toBe("unsupported");
		expect(r.log.said).toEqual([
			"Starting Ollama in the background.",
			"Ollama did not answer within 10 s.",
		]);
		expect(r.log.pulls).toEqual([]);
	});

	test("nobody to ask: Ollama is not started", async () => {
		const r = rig({ ollama: "installed", answer: null });
		expect(await offerJudge("auto", r.deps)).toBe("unsupported");
		expect(r.log.starts).toBe(0);
	});

	test("a remote Ollama host is never replaced by a local start", async () => {
		const r = rig({ ollama: "installed", env: { EIGHT_DECIDE_OLLAMA_HOST: "gpu-box:11434" } });
		expect(await offerJudge("auto", r.deps)).toBe("unsupported");
		expect(r.log.asked).toEqual([]);
		expect(r.log.starts).toBe(0);
	});

	test("/judge install is the yes: starts Ollama without a second question", async () => {
		const r = rig({ ollama: "installed" });
		expect(await offerJudge("command", r.deps)).toBe("installed");
		expect(r.log.asked).toEqual([]);
		expect(r.log.starts).toBe(1);
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

describe("the llama.cpp path (#4906)", () => {
	type Calls = {
		binary: number;
		model: number;
		started: [string, string][];
		asks: [string, boolean][];
	};
	function llamaRig(
		over: {
			existing?: { bin: string; gguf: string } | null;
			binary?: Awaited<ReturnType<NonNullable<NonNullable<JudgeDeps["llama"]>["ensureBinary"]>>>;
			model?: Awaited<ReturnType<NonNullable<NonNullable<JudgeDeps["llama"]>["ensureModel"]>>>;
			start?: Awaited<ReturnType<NonNullable<NonNullable<JudgeDeps["llama"]>["start"]>>>;
			answer?: boolean | null;
			enabled?: boolean;
			ollama?: "up" | "installed" | "none";
		} & Omit<Partial<JudgeDeps>, "ollama"> = {},
	) {
		const calls: Calls = { binary: 0, model: 0, started: [], asks: [] };
		let up = false;
		const { existing, binary, model, start, answer, enabled, ollama, ...extra } = over;
		let pulled: () => boolean = () => false;
		const r = rig({
			ollama: ollama ?? "none",
			probe: async () =>
				up || pulled() ? { backend: "llamacpp", model: "judge" } : { backend: "none", model: null },
			ask: async (line, defaultYes) => {
				calls.asks.push([line, defaultYes]);
				return answer === undefined ? true : answer;
			},
			llama: {
				enabled: enabled ?? true,
				existing: () => existing ?? null,
				ensureBinary: async () => {
					calls.binary++;
					return binary ?? { ok: true, bin: "/h/.8gent/bin/llama-server", source: "fetched" };
				},
				ensureModel: async (pct) => {
					calls.model++;
					pct(50);
					pct(100);
					return model ?? { ok: true, path: "/h/.8gent/models/judge/m.gguf" };
				},
				start: async (bin, gguf) => {
					calls.started.push([bin, gguf]);
					const res = start ?? { ok: true };
					if (res.ok) up = true;
					return res;
				},
			},
			...extra,
		});
		pulled = () => r.log.pulls.length > 0;
		return { ...r, calls };
	}

	test("first launch: one yes fetches llama-server and the model, starts it, confirms the judge answers", async () => {
		const r = llamaRig();
		expect(await offerJudge("auto", r.deps)).toBe("installed");
		expect(r.calls.asks).toEqual([[llamaAskLine(true), true]]);
		expect(r.calls.binary).toBe(1);
		expect(r.calls.model).toBe(1);
		expect(r.calls.started).toEqual([
			["/h/.8gent/bin/llama-server", "/h/.8gent/models/judge/m.gguf"],
		]);
		expect(r.log.pulls).toEqual([]); // nothing through Ollama
		expect(r.log.said.at(-1)).toContain("Safety judge ready");
		expect(r.log.progress.some((l) => l.includes("50%"))).toBe(true);
		expect(r.stored()).toBeNull();
	});

	test("the question defaults to No after an update, so a stray Enter downloads nothing", async () => {
		const r = llamaRig({ defaultYes: false, answer: false });
		expect(await offerJudge("auto", r.deps)).toBe("declined");
		expect(r.calls.asks).toEqual([[llamaAskLine(false), false]]);
		expect(llamaAskLine(false)).toContain("[y/N]");
		expect(r.calls.binary + r.calls.model + r.calls.started.length).toBe(0);
		expect(r.stored()).toBe("declined");
	});

	test("nobody to ask: nothing downloaded, nothing recorded", async () => {
		const r = llamaRig({ answer: null });
		expect(await offerJudge("auto", r.deps)).toBe("no-person");
		expect(r.calls.binary + r.calls.model).toBe(0);
		expect(r.stored()).toBeNull();
	});

	test("set up before and not running: started with no question and no download", async () => {
		const r = llamaRig({ existing: { bin: "/h/.8gent/bin/llama-server", gguf: "/h/m.gguf" } });
		expect(await offerJudge("auto", r.deps)).toBe("started");
		expect(r.calls.asks).toEqual([]);
		expect(r.calls.binary + r.calls.model).toBe(0);
		expect(r.calls.started).toEqual([["/h/.8gent/bin/llama-server", "/h/m.gguf"]]);
		expect(r.log.said[0]).toBe("Starting the safety judge in the background.");
	});

	test("/judge install is the yes: no question", async () => {
		const r = llamaRig();
		expect(await offerJudge("command", r.deps)).toBe("installed");
		expect(r.calls.asks).toEqual([]);
	});

	test("a system llama-server is a named fallback, never the default", async () => {
		const r = llamaRig({
			binary: { ok: true, bin: "/usr/bin/llama-server", source: "system", note: "offline" },
		});
		expect(await offerJudge("auto", r.deps)).toBe("installed");
		expect(
			r.log.said.some((l) => l.includes("/usr/bin/llama-server") && l.includes("offline")),
		).toBe(true);
	});

	test("model fails: says so, records failed, starts nothing", async () => {
		const r = llamaRig({ model: { ok: false, why: "does not match its pinned checksum" } });
		expect(await offerJudge("auto", r.deps)).toBe("failed");
		expect(r.log.said.at(-1)).toContain("pinned checksum");
		expect(r.calls.started).toEqual([]);
		expect(r.stored()).toBe("failed");
	});

	test("the server does not come up: one line, failed", async () => {
		const r = llamaRig({ start: { ok: false, line: "llama-server did not answer within 120 s." } });
		expect(await offerJudge("auto", r.deps)).toBe("failed");
		expect(r.log.said.at(-1)).toContain("did not answer within 120 s");
	});

	test("no llama-server to be had and no Ollama: failed with the reason", async () => {
		const r = llamaRig({
			binary: { ok: false, why: "no llama-server build for this platform yet" },
			ollama: "none",
		});
		expect(await offerJudge("auto", r.deps)).toBe("failed");
		expect(r.log.said.at(-1)).toContain("no llama-server build");
		expect(r.calls.model).toBe(0);
	});

	test("fallback: no llama-server but Ollama is installed, so Ollama is started and pulls the judge", async () => {
		const r = llamaRig({
			binary: { ok: false, why: "offline" },
			ollama: "installed",
			answer: true,
		});
		expect(await offerJudge("auto", r.deps)).toBe("installed");
		expect(r.log.said.some((l) => l.includes("Using Ollama instead"))).toBe(true);
		expect(r.log.starts).toBe(1); // the Ollama fallback was started
		expect(r.log.pulls).toEqual([JUDGE_MODEL]);
	});

	test("the llama path is on for Android and for EIGHT_JUDGE_RUNTIME=llama-server, off for =ollama", async () => {
		for (const [env, want] of [
			[{ TERMUX_VERSION: "0.118" }, true],
			[{ EIGHT_JUDGE_RUNTIME: "llama-server" }, true],
			[{ TERMUX_VERSION: "0.118", EIGHT_JUDGE_RUNTIME: "ollama" }, false],
			[{}, false],
		] as const) {
			const r = llamaRig({ env, enabled: undefined as unknown as boolean });
			// enabled undefined: let the environment decide.
			(r.deps.llama as { enabled?: boolean }).enabled = undefined;
			await offerJudge("auto", r.deps);
			expect(r.calls.binary > 0).toBe(want);
		}
	});

	test("Ollama start question also defaults to No after an update", async () => {
		const asks: [string, boolean][] = [];
		const r = rig({
			ollama: "installed",
			defaultYes: false,
			ask: async (l, d) => {
				asks.push([l, d]);
				return false;
			},
		});
		await offerJudge("auto", r.deps);
		expect(asks).toEqual([["Start Ollama in the background now? [y/N]", false]]);
		expect(r.log.starts).toBe(0);
	});
});
