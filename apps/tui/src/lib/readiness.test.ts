import { describe, expect, test } from "bun:test";
import {
	type BuildResult,
	CHECKING_REASON,
	type ReadinessInputs,
	type TurnError,
	buildResultFor,
	classifyTurnError,
	deriveReadiness,
	readinessBuildKey,
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

describe("deriveReadiness: every combination", () => {
	const builds: BuildResult[] = [{ kind: "built" }, { kind: "wait", notice: "openrouter did not report ready." }, { kind: "pending" }];
	const rows: Array<{ name: string; input: ReadinessInputs }> = [];
	for (const base of [ollama, openrouter])
		for (const engineUp of [true, false])
			for (const key of base === ollama ? (["not-needed"] as const) : (["present", "missing", "invalid"] as const))
				for (const build of builds)
					for (const firstProbeLanded of [false, true])
						for (const unreachableTurn of [false, true]) {
							const turnError: TurnError | null =
								key === "invalid"
									? { kind: "auth", provider: base.provider }
									: unreachableTurn
										? { kind: "unreachable", provider: base.provider }
										: null;
							rows.push({
								name: `${base.provider} engine=${engineUp ? "up" : "down"} key=${key} build=${build.kind} probe=${firstProbeLanded ? "landed" : "pending"} turnError=${turnError?.kind ?? "none"}`,
								input: {
									...base,
									engines: { ...base.engines, ollama: engineUp },
									keyStatus: key === "invalid" ? "present" : key,
									build,
									firstProbeLanded,
									turnError,
								},
							});
						}

	test("the sweep covers 2 x 1 x 3 x 2 x 2 local and 2 x 3 x 3 x 2 x 2 hosted rows", () => {
		expect(rows.length).toBe(24 + 72);
	});

	for (const { name, input } of rows) {
		test(name, () => {
			const r = deriveReadiness(input);
			// Same inputs, same answer.
			expect(deriveReadiness(structuredClone(input))).toEqual(r);
			const local = input.provider === "ollama";
			if (r.state === "ready") {
				expect(input.build.kind).toBe("built");
				expect(input.firstProbeLanded).toBe(true);
				expect(input.keyStatus).not.toBe("missing");
				expect(input.turnError?.kind).not.toBe("auth");
				if (local) expect(input.engines.ollama).toBe(true);
				else expect(input.turnError).toBeNull();
				expect(r.model).toBe(input.model);
				expect(r.reason).toBe("");
			} else {
				// Never names a model it cannot run on, never says nothing about why.
				expect(r.model).toBe("");
				expect(r.reason.length).toBeGreaterThan(0);
			}
			if (r.state === "checking") {
				expect(!input.firstProbeLanded || input.build.kind === "pending").toBe(true);
				expect(r.reason).toBe(CHECKING_REASON);
			}
			if (input.keyStatus === "missing") expect(r).toEqual({ state: "none", reason: "openrouter needs an API key.", model: "" });
			if (input.turnError?.kind === "auth") expect(r.reason).toBe("openrouter did not accept the API key.");
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
	test("key refusals in the assistant's [Error] reply", () => {
		for (const s of ["[Error] 401 Unauthorized", "[Error] HTTP 403", "[Error] No auth credentials found", "[Error] Invalid API key"]) {
			expect(classifyTurnError(reply(s))).toBe("auth");
		}
	});
	test("connection failures in the assistant's [Error] reply", () => {
		for (const s of ["[Error] fetch failed", "[Error] connect ECONNREFUSED 127.0.0.1:11434", "[Error] Unable to connect"]) {
			expect(classifyTurnError(reply(s))).toBe("unreachable");
		}
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
