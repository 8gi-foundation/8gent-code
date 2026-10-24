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
	JUDGE_UNSUPPORTED_LINE,
	type JudgeChoice,
	type JudgeDeps,
	NO_DEVICE_MODEL_LINE,
	cleanText,
	configPath,
	judgeAskLine,
	judgeBasis,
	llamaAskLine,
	offerJudge,
	pullModel,
	readChoice,
	readChoiceBasis,
	unattended,
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
	let storedBasis: string | null = null;
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
		writeChoice: (c, basis) => {
			log.writes.push(c);
			stored = c;
			storedBasis = basis ?? null;
			return true;
		},
		readBasis: () => storedBasis,
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

	test("Ollama installed but not running: asks once to start it, a no is recorded as declined and never asks again", async () => {
		const r = rig({ ollama: "installed", answer: false });
		expect(await offerJudge("auto", r.deps)).toBe("declined");
		expect(r.stored()).toBe("declined");
		expect(r.log.asked).toEqual(["Start Ollama in the background now? [y/N]"]);
		expect(r.log.starts).toBe(0);
		expect(r.log.said).toEqual([
			"OK. Risky commands are checked by the built-in safety rules only. Run /judge install if you change your mind.",
		]);
		expect(r.log.pulls).toEqual([]);
		expect(await offerJudge("auto", r.deps)).toBe("recorded");
		expect(r.log.asked.length).toBe(1);
	});

	test("Ollama installed but not running: yes starts it, then the judge question follows", async () => {
		const r = rig({ ollama: "installed", answer: true });
		expect(await offerJudge("auto", r.deps)).toBe("installed");
		expect(r.log.starts).toBe(1);
		expect(r.log.asked).toEqual(["Start Ollama in the background now? [y/N]", judgeAskLine(false)]);
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
			existing?: { bin: string; gguf: string; model: string } | null;
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
				start: async (bin, gguf, model) => {
					calls.started.push([bin, gguf]);
					expect(model).toBe(JUDGE_MODEL);
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
		expect(r.calls.asks).toEqual([[llamaAskLine(false), false]]);
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
		const r = llamaRig({
			existing: { bin: "/h/.8gent/bin/llama-server", gguf: "/h/m.gguf", model: JUDGE_MODEL },
		});
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

describe("first launch defers the judge question to the running TUI (#4909 regression)", () => {
	function phone(over: Omit<Partial<JudgeDeps>, "ollama"> = {}) {
		const asks: string[] = [];
		const writes: (string | null)[] = [];
		let stored: "declined" | "unsupported" | "failed" | null = null;
		const started: string[] = [];
		const r = rig({
			ollama: "none",
			ask: async (line) => {
				asks.push(line);
				return false;
			},
			llama: {
				enabled: true,
				existing: () => null,
				ensureBinary: async () => {
					throw new Error("launch must not fetch llama-server");
				},
				ensureModel: async () => {
					throw new Error("launch must not fetch the model");
				},
				start: async (bin) => {
					started.push(bin);
					return { ok: true };
				},
			},
			readChoice: () => stored,
			writeChoice: (c) => {
				writes.push(c);
				stored = c as typeof stored;
				return true;
			},
			...over,
		});
		return { ...r, asks, writes, started };
	}

	test("launch, no install on disk: asks nothing, records nothing, returns at once", async () => {
		const r = phone();
		const t0 = Date.now();
		expect(await offerJudge("launch", r.deps)).toBe("deferred");
		expect(Date.now() - t0).toBeLessThan(500);
		expect(r.asks).toEqual([]);
		expect(r.writes).toEqual([]);
		expect(r.log.said).toEqual([]);
	});

	test("launch with a verified llama-server and model on disk starts it and asks nothing", async () => {
		let up = false;
		const r = phone({
			probe: async () =>
				up ? { backend: "llamacpp", model: JUDGE_MODEL } : { backend: "none", model: null },
			llama: {
				enabled: true,
				existing: () => ({ bin: "/b/llama-server", gguf: "/m/j.gguf", model: JUDGE_MODEL }),
				hasProfile: () => true,
				start: async () => {
					up = true;
					return { ok: true };
				},
			},
		});
		expect(await offerJudge("launch", r.deps)).toBe("started");
		expect(r.asks).toEqual([]);
	});

	test("after first render the TUI's auto offer asks once, defaults to No, and a no is recorded", async () => {
		const r = phone();
		expect(await offerJudge("launch", r.deps)).toBe("deferred");
		expect(await offerJudge("auto", r.deps)).toBe("declined");
		expect(r.asks).toEqual([llamaAskLine(false)]);
		expect(r.writes).toEqual(["declined"]);
		// Next launch (pre-TUI) and the next TUI offer: the recorded no ends the asking.
		expect(await offerJudge("launch", r.deps)).toBe("recorded");
		expect(await offerJudge("auto", r.deps)).toBe("recorded");
		expect(r.asks.length).toBe(1);
	});

	test("/judge install still works after a recorded no", async () => {
		const r = phone();
		await offerJudge("auto", r.deps);
		const cmd = phone({
			readChoice: () => "declined",
			llama: {
				enabled: true,
				existing: () => null,
				ensureBinary: async () => ({ ok: true, bin: "/b/llama-server", source: "fetched" }),
				ensureModel: async () => ({ ok: true, path: "/m/j.gguf" }),
				start: async () => ({ ok: true }),
				catalogue: undefined,
			},
			probe: (() => {
				let n = 0;
				return async () =>
					n++ === 0
						? { backend: "none", model: null }
						: { backend: "llamacpp", model: JUDGE_MODEL };
			})(),
		});
		expect(await offerJudge("command", cmd.deps)).toBe("installed");
		expect(cmd.asks).toEqual([]);
	});
});

describe("no default yes, unattended, and device size (#4906)", () => {
	const GiB = 2 ** 30;
	const llamaFakes = (ram: number) => {
		const calls = { binary: 0, model: 0, started: 0 };
		return {
			calls,
			llama: {
				enabled: true,
				totalRamBytes: () => ram,
				existing: () => null,
				ensureBinary: async () => {
					calls.binary++;
					return { ok: true as const, bin: "/b/llama-server", source: "fetched" as const };
				},
				ensureModel: async () => {
					calls.model++;
					return { ok: true as const, path: "/m/j.gguf" };
				},
				start: async () => {
					calls.started++;
					return { ok: true as const };
				},
			},
		};
	};

	test("every judge question defaults to No: a bare Enter is a no", () => {
		expect(judgeAskLine()).toContain("[y/N]");
		expect(llamaAskLine()).toContain("[y/N]");
		expect(JUDGE_ASK_LINE).toContain("[y/N]");
	});

	test("with no defaultYes given, the llama question and the Ollama one are both asked as No", async () => {
		const asks: [string, boolean][] = [];
		const f = llamaFakes(16 * GiB);
		const r = rig({
			llama: f.llama,
			ask: async (l, d) => {
				asks.push([l, d]);
				return d; // a bare Enter
			},
		});
		expect(await offerJudge("auto", r.deps)).toBe("declined");
		expect(asks).toEqual([[llamaAskLine(false), false]]);
		expect(f.calls).toEqual({ binary: 0, model: 0, started: 0 });

		const o: [string, boolean][] = [];
		const r2 = rig({
			ollama: "installed",
			ask: async (l, d) => {
				o.push([l, d]);
				return d;
			},
		});
		await offerJudge("auto", r2.deps);
		expect(o).toEqual([["Start Ollama in the background now? [y/N]", false]]);
		expect(r2.log.starts).toBe(0);
	});

	test("unattended (CI, EIGHT_UNATTENDED, no terminal): the real prompt is no-person at once, nothing downloaded, nothing recorded", async () => {
		for (const env of [{ CI: "1" }, { EIGHT_UNATTENDED: "1" }, {}]) {
			for (const ollama of ["up", "installed"] as const) {
				const f = llamaFakes(16 * GiB);
				const r = rig({ env: { TERMUX_VERSION: "0.118", ...env }, ollama, llama: f.llama });
				// The default ask, not the rig's: bun test has no TTY on stdin.
				(r.deps as { ask?: unknown }).ask = undefined;
				const t0 = performance.now();
				expect(await offerJudge("auto", r.deps)).toBe("no-person");
				expect(performance.now() - t0).toBeLessThan(500);
				expect(f.calls).toEqual({ binary: 0, model: 0, started: 0 });
				expect(r.log.pulls).toEqual([]);
				expect(r.log.starts).toBe(0);
				expect(r.stored()).toBeNull();
			}
		}
	});

	test("CI or EIGHT_UNATTENDED wins even when a terminal is attached: the prompt is never opened", async () => {
		const inTty = process.stdin.isTTY;
		const outTty = process.stdout.isTTY;
		process.stdin.isTTY = true;
		process.stdout.isTTY = true;
		try {
			for (const env of [{ CI: "1" }, { EIGHT_UNATTENDED: "true" }]) {
				const f = llamaFakes(16 * GiB);
				const r = rig({ env: { TERMUX_VERSION: "0.118", ...env }, llama: f.llama });
				(r.deps as { ask?: unknown }).ask = undefined;
				expect(
					await Promise.race([offerJudge("auto", r.deps), Bun.sleep(1000).then(() => "hung")]),
				).toBe("no-person");
				expect(f.calls).toEqual({ binary: 0, model: 0, started: 0 });
			}
		} finally {
			process.stdin.isTTY = inTty;
			process.stdout.isTTY = outTty;
		}
	});

	test("unattended is true for CI or EIGHT_UNATTENDED, and the flags 0 and false do not turn it on", () => {
		expect(unattended({ CI: "true" })).toBe(true);
		expect(unattended({ EIGHT_UNATTENDED: "1" })).toBe(true);
		if (process.stdin.isTTY && process.stdout.isTTY)
			expect(unattended({ CI: "0", EIGHT_UNATTENDED: "false" })).toBe(false);
	});

	test("under 12 GB of RAM: nothing is asked or downloaded, one line, recorded once", async () => {
		for (const ram of [3 * GiB, 8 * GiB, 11.9 * GiB]) {
			const f = llamaFakes(ram);
			const r = rig({ llama: f.llama });
			expect(await offerJudge("auto", r.deps)).toBe("unsupported");
			expect(r.log.asked).toEqual([]);
			expect(f.calls).toEqual({ binary: 0, model: 0, started: 0 });
			expect(r.log.pulls).toEqual([]);
			expect(r.log.said).toEqual([NO_DEVICE_MODEL_LINE]);
			expect(NO_DEVICE_MODEL_LINE).toBe(
				"No judge model sized for this device yet; the safety check asks you instead.",
			);
			// Once: the next launch says nothing.
			expect(await offerJudge("auto", r.deps)).toBe("recorded");
			expect(r.log.said.length).toBe(1);
		}
	});

	test("/judge install on a small device says the line again and still downloads nothing", async () => {
		const f = llamaFakes(8 * GiB);
		const r = rig({ llama: f.llama });
		expect(await offerJudge("command", r.deps)).toBe("unsupported");
		expect(await offerJudge("command", r.deps)).toBe("unsupported");
		expect(r.log.said).toEqual([NO_DEVICE_MODEL_LINE, NO_DEVICE_MODEL_LINE]);
		expect(f.calls).toEqual({ binary: 0, model: 0, started: 0 });
	});

	test("12 GB or more: the pinned judge is offered", async () => {
		const f = llamaFakes(12 * GiB);
		const r = rig({
			llama: f.llama,
			answer: true,
			probe: async () =>
				f.calls.started > 0
					? { backend: "llamacpp", model: "judge" }
					: { backend: "none", model: null },
		});
		expect(await offerJudge("auto", r.deps)).toBe("installed");
		expect(f.calls.model).toBe(1);
	});
});

// #4965: the judge is named by the catalogue entry that was chosen, a model with no profile of its
// own is never set up, and "unsupported" is decided again when the catalogue or the device changes.
// The rows below are test-only: nothing is added to the real catalogue.
describe("the chosen catalogue entry names the judge; unsupported is not forever (#4965)", () => {
	const GiB = 2 ** 30;
	const OTHER = "test-org/not-selene-judge:q4";
	const otherRow = {
		model: OTHER,
		minRamBytes: 2 * GiB,
		pin: { sha256: "a".repeat(64), bytes: 1_250_000_000 },
	};
	const roots: string[] = [];
	afterAll(() => {
		for (const d of roots) rmSync(d, { recursive: true, force: true });
	});

	function fakes(opts: {
		ram: number;
		catalogue?: NonNullable<JudgeDeps["llama"]>["catalogue"];
		hasProfile?: (m: string) => boolean;
		existing?: { bin: string; gguf: string; model: string } | null;
	}) {
		const calls = {
			started: [] as [string, string, string][],
			fetched: [] as [string, string][],
			binary: 0,
		};
		let up = false;
		const llama: NonNullable<JudgeDeps["llama"]> = {
			enabled: true,
			totalRamBytes: () => opts.ram,
			catalogue: opts.catalogue,
			hasProfile: opts.hasProfile,
			existing: () => opts.existing ?? null,
			ensureBinary: async () => {
				calls.binary++;
				return { ok: true, bin: "/b/llama-server", source: "fetched" };
			},
			ensureModel: async (pct, pin, model) => {
				calls.fetched.push([pin.sha256, model]);
				pct(100);
				return { ok: true, path: "/m/j.gguf" };
			},
			start: async (bin, gguf, model) => {
				calls.started.push([bin, gguf, model]);
				up = true;
				return { ok: true };
			},
		};
		const probe = async () =>
			up
				? { backend: "llamacpp", model: calls.started.at(-1)?.[2] ?? null }
				: { backend: "none", model: null };
		return { calls, llama, probe };
	}

	test("a non-Selene entry is downloaded, started and named as itself, never as Selene", async () => {
		const f = fakes({ ram: 4 * GiB, catalogue: [otherRow], hasProfile: (m) => m === OTHER });
		const r = rig({ llama: f.llama, probe: f.probe, answer: true });
		expect(await offerJudge("auto", r.deps)).toBe("installed");
		expect(f.calls.fetched).toEqual([[otherRow.pin.sha256, OTHER]]);
		expect(f.calls.started).toEqual([["/b/llama-server", "/m/j.gguf", OTHER]]);
		// The question and the progress name its size and its name, not Selene's.
		expect(r.log.asked).toEqual([llamaAskLine(false, "1.3 GB")]);
		expect(r.log.progress.some((l) => l.includes(OTHER))).toBe(true);
		expect(r.log.progress.some((l) => l.includes(JUDGE_MODEL))).toBe(false);
		expect(r.log.said.at(-1)).toBe(`Safety judge ready: ${OTHER} via llamacpp.`);
	});

	test("set up before: the file on disk is started under its own entry's name", async () => {
		const f = fakes({
			ram: 4 * GiB,
			catalogue: [otherRow],
			hasProfile: (m) => m === OTHER,
			existing: { bin: "/b/llama-server", gguf: "/m/other.gguf", model: OTHER },
		});
		const r = rig({ llama: f.llama, probe: f.probe });
		expect(await offerJudge("auto", r.deps)).toBe("started");
		expect(f.calls.started).toEqual([["/b/llama-server", "/m/other.gguf", OTHER]]);
	});

	test("missing profile for that exact model: no judge, nothing asked, downloaded or started", async () => {
		for (const existing of [
			null,
			{ bin: "/b/llama-server", gguf: "/m/other.gguf", model: OTHER },
		]) {
			const f = fakes({ ram: 64 * GiB, catalogue: [otherRow], hasProfile: () => false, existing });
			const r = rig({ llama: f.llama, probe: f.probe, answer: true });
			expect(await offerJudge("command", r.deps)).toBe("unsupported");
			expect(r.log.asked).toEqual([]);
			expect(f.calls).toEqual({ started: [], fetched: [], binary: 0 });
			expect(r.log.said).toEqual([NO_DEVICE_MODEL_LINE]);
		}
	});

	test("a profile-less row is skipped for the next row that has one", async () => {
		const bigNoProfile = { ...otherRow, model: "test-org/uncalibrated:q8", minRamBytes: 1 * GiB };
		const f = fakes({
			ram: 8 * GiB,
			catalogue: [bigNoProfile, otherRow],
			hasProfile: (m) => m === OTHER,
		});
		const r = rig({ llama: f.llama, probe: f.probe, answer: true });
		expect(await offerJudge("auto", r.deps)).toBe("installed");
		expect(f.calls.started.map((c) => c[2])).toEqual([OTHER]);
	});

	function realStore() {
		const h = mkdtempSync(join(tmpdir(), "judge-basis-"));
		roots.push(h);
		return { EIGHT_HOME: h };
	}
	const storeDeps = (env: Record<string, string>, f: ReturnType<typeof fakes>, answer: boolean) => {
		const r = rig({ env, llama: f.llama, probe: f.probe, answer });
		// The real config file, not the rig's memory: what a person's device keeps between launches.
		for (const k of ["readChoice", "writeChoice", "readBasis"] as const)
			(r.deps as Record<string, unknown>)[k] = undefined;
		return r;
	};

	test("a stale unsupported verdict re-evaluates when the catalogue gains a calibrated row for this device", async () => {
		const env = realStore();
		// Today: no row fits a 6 GB phone.
		const before = fakes({
			ram: 6 * GiB,
			catalogue: [{ ...otherRow, minRamBytes: 12 * GiB }],
			hasProfile: () => true,
		});
		expect(await offerJudge("auto", storeDeps(env, before, true).deps)).toBe("unsupported");
		expect(readChoice(env)).toBe("unsupported");
		expect(readChoiceBasis(env)).toBe(judgeBasis(6 * GiB, before.llama.catalogue, () => true));
		// Same catalogue, same device: nothing asked again.
		const again = storeDeps(env, before, true);
		expect(await offerJudge("auto", again.deps)).toBe("recorded");
		expect(again.log.said).toEqual([]);

		// An update ships a row this phone fits: decided again, the person is asked, the judge installs.
		const after = fakes({ ram: 6 * GiB, catalogue: [otherRow], hasProfile: () => true });
		const r = storeDeps(env, after, true);
		expect(await offerJudge("auto", r.deps)).toBe("installed");
		expect(r.log.asked).toEqual([llamaAskLine(false, "1.3 GB")]);
		expect(after.calls.started.map((c) => c[2])).toEqual([OTHER]);
		expect(readChoice(env)).toBeNull();
	});

	test("a stale unsupported verdict re-evaluates when a profile ships for a row already there", async () => {
		const env = realStore();
		const noProfile = fakes({ ram: 6 * GiB, catalogue: [otherRow], hasProfile: () => false });
		expect(await offerJudge("auto", storeDeps(env, noProfile, true).deps)).toBe("unsupported");
		const withProfile = fakes({ ram: 6 * GiB, catalogue: [otherRow], hasProfile: () => true });
		expect(await offerJudge("auto", storeDeps(env, withProfile, false).deps)).toBe("declined");
	});

	test("a stale unsupported verdict re-evaluates when the hardware changes", async () => {
		const env = realStore();
		const small = fakes({
			ram: 6 * GiB,
			catalogue: [{ ...otherRow, minRamBytes: 12 * GiB }],
			hasProfile: () => true,
		});
		expect(await offerJudge("auto", storeDeps(env, small, true).deps)).toBe("unsupported");
		const big = fakes({
			ram: 16 * GiB,
			catalogue: [{ ...otherRow, minRamBytes: 12 * GiB }],
			hasProfile: () => true,
		});
		expect(await offerJudge("auto", storeDeps(env, big, true).deps)).toBe("installed");
	});

	test("an older unsupported record with no basis is decided once more, then recorded with one", async () => {
		const env = realStore();
		expect(writeChoice("unsupported", env)).toBe(true);
		expect(readChoiceBasis(env)).toBeNull();
		const f = fakes({
			ram: 6 * GiB,
			catalogue: [{ ...otherRow, minRamBytes: 12 * GiB }],
			hasProfile: () => true,
		});
		const r = storeDeps(env, f, true);
		expect(await offerJudge("auto", r.deps)).toBe("unsupported");
		expect(r.log.said).toEqual([NO_DEVICE_MODEL_LINE]);
		expect(readChoiceBasis(env)).not.toBeNull();
		expect(await offerJudge("auto", storeDeps(env, f, true).deps)).toBe("recorded");
	});

	test("a no to starting Ollama is a person's no: recorded as declined, never re-asked after a catalogue change", async () => {
		const llama = (sha: string): NonNullable<JudgeDeps["llama"]> => ({
			enabled: false,
			totalRamBytes: () => 8 * GiB,
			catalogue: [{ ...otherRow, pin: { ...otherRow.pin, sha256: sha } }],
			hasProfile: () => true,
		});
		const r = rig({ ollama: "installed", answer: false, llama: llama("a".repeat(64)) });
		expect(await offerJudge("auto", r.deps)).toBe("declined");
		expect(r.stored()).toBe("declined");
		expect(r.log.starts).toBe(0);
		expect(r.log.said).toEqual([
			"OK. Risky commands are checked by the built-in safety rules only. Run /judge install if you change your mind.",
		]);
		// An update ships a different catalogue: the stale-basis rule is for "unsupported" only.
		r.deps.llama = llama("b".repeat(64));
		expect(await offerJudge("auto", r.deps)).toBe("recorded");
		expect(r.log.asked.length).toBe(1);
	});

	test("a person's no and a failure stay final whatever the catalogue does", async () => {
		for (const c of ["declined", "failed"] as const) {
			const env = realStore();
			expect(writeChoice(c, env)).toBe(true);
			const f = fakes({ ram: 64 * GiB, catalogue: [otherRow], hasProfile: () => true });
			const r = storeDeps(env, f, true);
			expect(await offerJudge("auto", r.deps)).toBe("recorded");
			expect(r.log.asked).toEqual([]);
			expect(f.calls.binary).toBe(0);
		}
	});
});
