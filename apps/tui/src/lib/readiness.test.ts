import { describe, expect, test } from "bun:test";
import {
	type BuildResult,
	CHECKING_REASON,
	type ReadinessInputs,
	type ReadinessState,
	type TurnError,
	buildResultFor,
	classifyTurnError,
	deriveReadiness,
	readinessBuildKey,
	turnEndFacts,
} from "./readiness.js";

/**
 * One deterministic answer to "can this tab run a turn?" (#3290). The header
 * strip and the NO MODEL card both render from it. These tests sweep every
 * combination of the live facts it reads, then pin each rule and the
 * mid-session sequence (ready, engine lost, engine back) by name.
 */

const ollama: ReadinessInputs = {
	provider: "ollama",
	model: "qwen3.5",
	firstProbeLanded: true,
	engines: { apfel: false, lmstudio: false, ollama: true },
	keyStatus: "not-needed",
	unreachable: null,
	build: { kind: "built" },
	turnError: null,
};
const openrouter: ReadinessInputs = {
	...ollama,
	provider: "openrouter",
	model: "deepseek/deepseek-r1:free",
	engines: { apfel: false, lmstudio: false, ollama: false },
	keyStatus: "present",
};

describe("deriveReadiness: every combination, against a golden table", () => {
	// Each row's expected {state, reason} is pinned in the snapshot file next
	// to this test, one line per row, so swapping two rules changes lines and
	// fails. The invariants below hold for every row on their own.
	const NOTE = "Ollama at 127.0.0.1:11434 did not answer.";
	const builds: BuildResult[] = [
		{ kind: "built" },
		{ kind: "wait", notice: "openrouter did not report ready." },
		{ kind: "pending" },
	];
	const rows: Array<{ name: string; input: ReadinessInputs }> = [];
	for (const provider of ["ollama", "8gent", "", "lmstudio", "openrouter"])
		for (const ollamaUp of [true, false])
			for (const lmstudioUp of [true, false])
				for (const key of provider === "openrouter"
					? (["present", "missing", "invalid"] as const)
					: (["not-needed"] as const))
					for (const build of builds)
						for (const firstProbeLanded of [false, true])
							for (const unreachableTurn of [false, true])
								for (const unreachable of [null, NOTE]) {
									const turnError: TurnError | null =
										key === "invalid"
											? { kind: "auth", provider }
											: unreachableTurn
												? { kind: "unreachable", provider }
												: null;
									rows.push({
										name: [
											`provider=${provider || "(none)"}`,
											`ollama=${ollamaUp ? "up" : "down"}`,
											`lmstudio=${lmstudioUp ? "up" : "down"}`,
											`key=${key}`,
											`build=${build.kind}`,
											`probe=${firstProbeLanded ? "landed" : "pending"}`,
											`turnError=${turnError?.kind ?? "none"}`,
											`initNote=${unreachable ? "yes" : "no"}`,
										].join(" "),
										input: {
											provider,
											model: "m",
											firstProbeLanded,
											engines: { apfel: false, lmstudio: lmstudioUp, ollama: ollamaUp },
											keyStatus: key === "invalid" ? "present" : key,
											unreachable,
											build,
											turnError,
										},
									});
								}

	test("the sweep covers 4 local providers x 96 and openrouter x 288", () => {
		expect(rows.length).toBe(4 * (4 * 3 * 2 * 2 * 2) + 4 * 3 * 3 * 2 * 2 * 2);
	});

	test("golden table: every row's state and reason", () => {
		const table = rows
			.map(({ name, input }) => {
				const r = deriveReadiness(input);
				return `${name} -> ${r.state}${r.reason ? ` "${r.reason}"` : ""}`;
			})
			.join("\n");
		expect(table).toMatchSnapshot();
	});

	test("invariants hold on every row", () => {
		for (const { name, input } of rows) {
			const r = deriveReadiness(input);
			const fail = (why: string) => {
				throw new Error(`${name}: ${why}`);
			};
			const local = input.provider !== "openrouter";
			if (r.state === "ready") {
				if (input.build.kind !== "built") fail("ready without a build");
				if (!input.firstProbeLanded) fail("ready before the first probe");
				if (input.keyStatus === "missing") fail("ready with no key");
				if (input.unreachable) fail("ready over an init note");
				if (!local && input.turnError) fail("hosted ready over a turn error");
				if (r.model !== "m" || r.reason !== "") fail("ready must name the model, with no reason");
			} else {
				if (r.model !== "") fail("not ready but names a model");
				if (!r.reason) fail("not ready without a reason");
			}
			if (r.state === "checking" && input.firstProbeLanded && input.build.kind !== "pending") {
				fail("checking after the probe and the build both landed");
			}
			if (local && r.reason.includes("API key")) fail("a local provider read a key reason");
			if (input.unreachable && r.state !== "none") fail("an init note did not read none");
		}
	});
});

describe("deriveReadiness: rule order, pinned where two facts conflict", () => {
	const NOTE = "Ollama at 127.0.0.1:11434 did not answer.";
	const cases: Array<[string, ReadinessInputs, { state: ReadinessState; reason: string }]> = [
		[
			"1 before 2: a missing key outranks a refused one",
			{ ...openrouter, keyStatus: "missing", turnError: { kind: "auth", provider: "openrouter" } },
			{ state: "none", reason: "openrouter needs an API key." },
		],
		[
			"3 prefers the init note over the generic line",
			{ ...ollama, engines: { ollama: false }, unreachable: NOTE },
			{ state: "none", reason: NOTE },
		],
		[
			"4: an init note reads none before the first probe",
			{ ...ollama, firstProbeLanded: false, unreachable: NOTE },
			{ state: "none", reason: NOTE },
		],
		[
			"4: an init note reads none while apfel and ollama are both up",
			{ ...ollama, engines: { apfel: true, lmstudio: false, ollama: true }, unreachable: NOTE },
			{ state: "none", reason: NOTE },
		],
		[
			"5 before 6: an unreachable hosted turn outranks a build notice",
			{
				...openrouter,
				build: { kind: "wait", notice: "w" },
				turnError: { kind: "unreachable", provider: "openrouter" },
			},
			{ state: "none", reason: "openrouter could not be reached." },
		],
		[
			"6 before 7: a build notice reads none even before the first probe",
			{ ...openrouter, firstProbeLanded: false, build: { kind: "wait", notice: "w" } },
			{ state: "none", reason: "w" },
		],
		[
			"3: an engine the probe did not report on is not down",
			{ ...ollama, provider: "llama-server", engines: { apfel: false, lmstudio: false, ollama: false } },
			{ state: "ready", reason: "" },
		],
	];
	for (const [name, input, want] of cases) {
		test(name, () => {
			const r = deriveReadiness(input);
			expect({ state: r.state, reason: r.reason }).toEqual(want);
		});
	}
});

describe("deriveReadiness: each rule by name", () => {
	test("built, probe landed, engine up: ready, naming the model", () => {
		expect(deriveReadiness(ollama)).toEqual({ state: "ready", reason: "", model: "qwen3.5" });
	});

	test("missing key is none before any network: no probe, no build needed", () => {
		expect(
			deriveReadiness({ ...openrouter, keyStatus: "missing", firstProbeLanded: false, build: { kind: "pending" } }),
		).toEqual({ state: "none", reason: "openrouter needs an API key.", model: "" });
	});

	test("a built agent does not outrank a refused key", () => {
		expect(deriveReadiness({ ...openrouter, turnError: { kind: "auth", provider: "openrouter" } }).state).toBe("none");
	});

	test("another provider's turn error is not this one's fact", () => {
		expect(deriveReadiness({ ...openrouter, turnError: { kind: "auth", provider: "groq" } }).state).toBe("ready");
	});

	test("a local engine the probe found down: none, with the init reason when there is one", () => {
		const down = { ...ollama, engines: { ...ollama.engines, ollama: false } };
		expect(deriveReadiness(down)).toEqual({ state: "none", reason: "Ollama is not answering.", model: "" });
		const unreachable = "Ollama at 127.0.0.1:11434 did not answer.";
		expect(deriveReadiness({ ...down, unreachable }).reason).toBe(unreachable);
	});

	test("the 8gent provider is served by the Ollama engine", () => {
		expect(deriveReadiness({ ...ollama, provider: "8gent", engines: { ollama: false, lmstudio: true } }).state).toBe("none");
	});

	test("no provider chosen yet: any engine answering will do", () => {
		const any = { ...ollama, provider: "" };
		expect(deriveReadiness({ ...any, engines: { ollama: false, lmstudio: true } }).state).toBe("ready");
		expect(deriveReadiness({ ...any, engines: { ollama: false, lmstudio: false } }).reason).toBe(
			"No local model is answering.",
		);
	});

	test("a hosted provider whose last turn could not connect: none until a turn succeeds", () => {
		expect(deriveReadiness({ ...openrouter, turnError: { kind: "unreachable", provider: "openrouter" } })).toEqual({
			state: "none",
			reason: "openrouter could not be reached.",
			model: "",
		});
	});

	test("a local connection failure is the probe's to judge, not a sticky turn error", () => {
		// The app re-probes at once on such a failure; an engine that answers wins.
		expect(deriveReadiness({ ...ollama, turnError: { kind: "unreachable", provider: "ollama" } }).state).toBe("ready");
	});

	test("a build that ended not ready: none with its notice, never a stuck CHECK", () => {
		expect(deriveReadiness({ ...openrouter, build: { kind: "wait", notice: "openrouter did not report ready." } })).toEqual({
			state: "none",
			reason: "openrouter did not report ready.",
			model: "",
		});
	});

	test("checking only while the first probe or the build is still out", () => {
		expect(deriveReadiness({ ...ollama, firstProbeLanded: false }).state).toBe("checking");
		expect(deriveReadiness({ ...ollama, build: { kind: "pending" } }).state).toBe("checking");
	});

	test("a provider that needs no key and no engine (host CLI) is the build's to judge", () => {
		const cli = { ...openrouter, provider: "host-cli-primary", keyStatus: "not-needed" as const };
		expect(deriveReadiness(cli).state).toBe("ready");
		expect(deriveReadiness({ ...cli, build: { kind: "wait", notice: "x" } }).state).toBe("none");
	});
});

describe("mid-session: the answer follows the engine, no restart", () => {
	test("ready, then the probe drops Ollama to none, then it recovers to ready", () => {
		const probe = (up: boolean) => deriveReadiness({ ...ollama, engines: { ...ollama.engines, ollama: up } });
		// The built agent stays built throughout: only the probe changes.
		expect(probe(true).state).toBe("ready");
		expect(probe(false)).toEqual({ state: "none", reason: "Ollama is not answering.", model: "" });
		expect(probe(true)).toEqual({ state: "ready", reason: "", model: "qwen3.5" });
	});
});

describe("build facts are keyed to their tab, provider and model", () => {
	const key = readinessBuildKey("tab-1", "ollama", "qwen3.5");
	test("a result for this key counts", () => {
		expect(buildResultFor({ key, notice: null }, key)).toEqual({ kind: "built" });
		expect(buildResultFor({ key, notice: "no" }, key)).toEqual({ kind: "wait", notice: "no" });
	});
	test("a result for another tab, provider or model is pending", () => {
		expect(buildResultFor(null, key)).toEqual({ kind: "pending" });
		for (const other of [
			readinessBuildKey("tab-2", "ollama", "qwen3.5"),
			readinessBuildKey("tab-1", "lmstudio", "qwen3.5"),
			readinessBuildKey("tab-1", "ollama", "other"),
		]) {
			expect(buildResultFor({ key: other, notice: null }, key)).toEqual({ kind: "pending" });
		}
	});
});

describe("classifyTurnError: only the agent's own failure counts", () => {
	const reply = (content: string) => ({ role: "assistant", content });
	const auth = ["401", "403", "unauthorized", "Unauthorised", "invalid api key", "no auth credentials", "authentication"];
	const connect = [
		"ECONNREFUSED",
		"connection refused",
		"fetch failed",
		"unable to connect",
		"ENOTFOUND",
		"EHOSTUNREACH",
		"timed out",
	];
	for (const word of auth) {
		test(`auth: ${word}`, () => expect(classifyTurnError(reply(`[Error] ${word}`))).toBe("auth"));
	}
	for (const word of connect) {
		test(`connect: ${word}`, () => expect(classifyTurnError(reply(`[Error] ${word}`))).toBe("unreachable"));
	}
	test("auth and connect words together: the key refusal wins", () => {
		expect(classifyTurnError(reply("[Error] 401 Unauthorized after connection refused"))).toBe("auth");
	});
	test("a failed tool result is never a readiness fact, whatever it says", () => {
		expect(classifyTurnError({ role: "tool", content: "gh: HTTP 401: Bad credentials" })).toBeNull();
		expect(classifyTurnError({ role: "tool", content: "web_fetch: fetch failed" })).toBeNull();
	});
	test("generic system text and plain assistant prose are not either", () => {
		expect(classifyTurnError({ role: "system", content: "Command failed: 401 from the API" })).toBeNull();
		expect(classifyTurnError(reply("The server answered 401, so I stopped."))).toBeNull();
	});
	test("a model that answered badly is not a readiness fact", () => {
		expect(classifyTurnError(reply("[Error] the tool returned no output"))).toBeNull();
		expect(classifyTurnError(undefined)).toBeNull();
	});
});

describe("turnEndFacts: what a finished turn changes, and what to do now", () => {
	const err = (content: string) => ({ role: "assistant", content: `[Error] ${content}` });
	test("a clean turn clears the last error and does nothing else", () => {
		expect(turnEndFacts(undefined, "ollama", false)).toEqual({ turnError: null, probeNow: false, retryBuild: false });
		expect(turnEndFacts({ role: "assistant", content: "done" }, "openrouter", false).turnError).toBeNull();
	});
	test("a local engine that could not be reached is probed now", () => {
		for (const p of ["ollama", "8gent", "lmstudio", ""]) {
			expect(turnEndFacts(err("fetch failed"), p, false)).toEqual({
				turnError: { kind: "unreachable", provider: p },
				probeNow: true,
				retryBuild: false,
			});
		}
	});
	test("no second probe while one is already running", () => {
		expect(turnEndFacts(err("fetch failed"), "ollama", true).probeNow).toBe(false);
	});
	test("a hosted provider that could not be reached gets its build retried, not a probe", () => {
		expect(turnEndFacts(err("fetch failed"), "openrouter", false)).toEqual({
			turnError: { kind: "unreachable", provider: "openrouter" },
			probeNow: false,
			retryBuild: true,
		});
	});
	test("a refused key is recorded against the provider the turn ran on, with no probe", () => {
		expect(turnEndFacts(err("401 Unauthorized"), "openrouter", false)).toEqual({
			turnError: { kind: "auth", provider: "openrouter" },
			probeNow: false,
			retryBuild: false,
		});
	});
	test("a failed tool result changes nothing", () => {
		expect(turnEndFacts({ role: "tool", content: "web_fetch: fetch failed" }, "ollama", false)).toEqual({
			turnError: null,
			probeNow: false,
			retryBuild: false,
		});
	});
});

describe("a failed tool never makes a healthy agent read NO MODEL", () => {
	const from = (input: ReadinessInputs, last: { role: string; content: string }) => {
		const kind = classifyTurnError(last);
		return deriveReadiness({ ...input, turnError: kind ? { kind, provider: input.provider } : null });
	};
	test("a gh 401 tool result on a built Ollama agent: still ready", () => {
		expect(from(ollama, { role: "tool", content: "gh: HTTP 401: Bad credentials" }).state).toBe("ready");
	});
	test("a failed web fetch tool result on built OpenRouter: still ready", () => {
		expect(from(openrouter, { role: "tool", content: "web_fetch: fetch failed" }).state).toBe("ready");
	});
	test("a local provider can never read 'did not accept the API key'", () => {
		for (const provider of ["ollama", "8gent", "lmstudio", ""]) {
			const r = deriveReadiness({ ...ollama, provider, engines: { ollama: true, lmstudio: true }, turnError: { kind: "auth", provider } });
			expect(r.reason).not.toContain("API key");
			expect(r.state).toBe("ready");
		}
	});
	test("a real [Error] reply carrying a 401 on OpenRouter still reads none", () => {
		expect(from(openrouter, { role: "assistant", content: "[Error] OpenRouter API error: 401 Unauthorized" })).toEqual({
			state: "none",
			reason: "openrouter did not accept the API key.",
			model: "",
		});
	});
});
