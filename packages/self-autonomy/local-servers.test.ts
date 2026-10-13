/**
 * #4206: first run finds every local model server on every OS, offers a
 * choice when it finds several, gives a plain next step when it finds none,
 * and saves the pick. Fetch and platform are stubbed: no model server is needed.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isLoopbackUrl } from "../local-model-server/select";
import { ProviderManager } from "../providers/index";
import {
	detectLocalServers,
	installGuideUrl,
	missingKeyNotice,
	providerChoiceScreen,
	readableModelName,
	resolveProviderChoice,
	saveProviderChoice,
	serverModelsLine,
} from "./local-servers";
import { type OllamaCheck, OnboardingManager, providerInstallHint } from "./onboarding";

type Routes = Record<string, unknown | number>;

/** A fetch that answers from a table: a body is 200 JSON, a number is that status, absent is refused. */
function stubFetch(routes: Routes, seen: string[] = []): typeof fetch {
	return (async (input: string | URL | Request) => {
		const url = String(input instanceof Request ? input.url : input);
		seen.push(url);
		if (!(url in routes)) throw new TypeError("connection refused");
		const r = routes[url];
		if (typeof r === "number") return new Response("", { status: r });
		return Response.json(r);
	}) as typeof fetch;
}

const LLAMA = {
	"http://127.0.0.1:8080/health": { status: "ok" },
	"http://127.0.0.1:8080/v1/models": { data: [{ id: "qwen3-8b-q4_k_m.gguf" }] },
};
const LMSTUDIO = {
	"http://127.0.0.1:1234/v1/models": {
		data: [{ id: "google/gemma-4-26b-a4b" }, { id: "text-embedding-nomic" }],
	},
};
const APFEL = { "http://127.0.0.1:11435/v1/models": { data: [{ id: "apple-foundationmodel" }] } };
const OLLAMA_FOUND: OllamaCheck = {
	status: "found",
	host: "http://localhost:11434",
	models: ["eight-1.0-q3:14b", "qwen3:14b"],
};
const OLLAMA_MISS: OllamaCheck = {
	status: "unreachable",
	host: "http://localhost:11434",
	reason: "connection refused or no route",
	configured: false,
	timedOut: false,
};

const OSES = [
	["win32", "x64"],
	["linux", "x64"],
	["darwin", "arm64"],
] as const;

describe("detectLocalServers", () => {
	for (const [platform, arch] of OSES) {
		test(`finds llama-server on 127.0.0.1:8080 on ${platform}`, async () => {
			const found = await detectLocalServers({
				env: {},
				platform,
				arch,
				fetchImpl: stubFetch(LLAMA),
			});
			expect(found.map((s) => s.id)).toEqual(["llama-server"]);
			expect(found[0].models).toEqual(["qwen3-8b-q4_k_m.gguf"]);
		});

		test(`finds LM Studio on its default port 1234 on ${platform}, embeddings left out`, async () => {
			const found = await detectLocalServers({
				env: {},
				platform,
				arch,
				fetchImpl: stubFetch(LMSTUDIO),
			});
			expect(found.map((s) => s.id)).toEqual(["lmstudio"]);
			expect(found[0].models).toEqual(["google/gemma-4-26b-a4b"]);
		});
	}

	test("follows LLAMA_SERVER_URL", async () => {
		const routes = {
			"http://127.0.0.1:8081/health": {},
			"http://127.0.0.1:8081/v1/models": { data: [{ id: "m.gguf" }] },
		};
		const found = await detectLocalServers({
			env: { LLAMA_SERVER_URL: "127.0.0.1:8081/v1" },
			platform: "win32",
			fetchImpl: stubFetch(routes),
		});
		expect(found.map((s) => s.url)).toEqual(["http://127.0.0.1:8081"]);
	});

	test("never probes a non-loopback LLAMA_SERVER_URL or LM_STUDIO_HOST", async () => {
		const seen: string[] = [];
		const found = await detectLocalServers({
			env: { LLAMA_SERVER_URL: "http://192.168.1.20:8080", LM_STUDIO_HOST: "http://10.0.0.5:1234" },
			platform: "linux",
			fetchImpl: stubFetch({}, seen),
		});
		expect(found).toEqual([]);
		expect(seen.filter((u) => !isLoopbackUrl(u))).toEqual([]);
	});

	test("a redirect is a miss: the probe never follows it off loopback", async () => {
		const inits: Array<RequestInit | undefined> = [];
		const redirecting = (async (_u: string, init?: RequestInit) => {
			inits.push(init);
			return new Response("", {
				status: 302,
				headers: { location: "http://203.0.113.9/v1/models" },
			});
		}) as typeof fetch;
		const found = await detectLocalServers({ env: {}, platform: "linux", fetchImpl: redirecting });
		expect(found).toEqual([]);
		expect(inits.length).toBeGreaterThan(0);
		expect(inits.every((i) => i?.redirect === "manual")).toBe(true);
	});

	test("a /health route alone is not llama-server: /v1/models must list", async () => {
		const routes = { "http://127.0.0.1:8080/health": {}, "http://127.0.0.1:8080/v1/models": 404 };
		expect(
			await detectLocalServers({ env: {}, platform: "linux", fetchImpl: stubFetch(routes) }),
		).toEqual([]);
	});

	test("a loading llama-server (503 on /health) is not offered yet", async () => {
		const routes = { ...LLAMA, "http://127.0.0.1:8080/health": 503 };
		expect(
			await detectLocalServers({ env: {}, platform: "win32", fetchImpl: stubFetch(routes) }),
		).toEqual([]);
	});

	test("apfel is probed on Apple Silicon only", async () => {
		const seen: string[] = [];
		const mac = await detectLocalServers({
			env: {},
			platform: "darwin",
			arch: "arm64",
			fetchImpl: stubFetch(APFEL),
		});
		expect(mac.map((s) => s.id)).toEqual(["apfel"]);
		await detectLocalServers({
			env: {},
			platform: "win32",
			arch: "x64",
			fetchImpl: stubFetch(APFEL, seen),
		});
		expect(seen.some((u) => u.includes("11435"))).toBe(false);
	});

	test("reuses the launch Ollama probe instead of asking again", async () => {
		const seen: string[] = [];
		const found = await detectLocalServers({
			env: {},
			platform: "linux",
			fetchImpl: stubFetch({}, seen),
			ollama: OLLAMA_FOUND,
		});
		expect(found.map((s) => s.id)).toEqual(["ollama"]);
		expect(seen.some((u) => u.includes("11434"))).toBe(false);
	});

	test("a server with no chat model is not offered: there is nothing to save", async () => {
		const empty = { "http://127.0.0.1:1234/v1/models": { data: [{ id: "text-embedding-nomic" }] } };
		const ollamaEmpty: OllamaCheck = {
			status: "found",
			host: "http://localhost:11434",
			models: [],
		};
		expect(
			await detectLocalServers({
				env: {},
				platform: "linux",
				fetchImpl: stubFetch(empty),
				ollama: ollamaEmpty,
			}),
		).toEqual([]);
	});

	test("several found: today's startup order, a selected llama-server first", async () => {
		const all = { ...LLAMA, ...LMSTUDIO, ...APFEL };
		const opts = {
			platform: "darwin",
			arch: "arm64",
			fetchImpl: stubFetch(all),
			ollama: OLLAMA_FOUND,
		};
		const plain = await detectLocalServers({ ...opts, env: {} });
		expect(plain.map((s) => s.id)).toEqual(["lmstudio", "ollama", "llama-server", "apfel"]);
		const selected = await detectLocalServers({
			...opts,
			env: { EIGHT_LOCAL_SERVER: "llama-server" },
		});
		expect(selected[0].id).toBe("llama-server");
	});

	test("a server that never answers costs at most the timeout", async () => {
		const hang = ((_u: string, init?: RequestInit) =>
			new Promise((_res, rej) =>
				init?.signal?.addEventListener("abort", () => rej(new DOMException("t", "TimeoutError"))),
			)) as typeof fetch;
		const t0 = Date.now();
		const found = await detectLocalServers({
			env: {},
			platform: "darwin",
			arch: "arm64",
			fetchImpl: hang,
			timeoutMs: 60,
		});
		expect(found).toEqual([]);
		expect(Date.now() - t0).toBeLessThan(1000);
	});
});

describe("choice screen", () => {
	test("none found: a plain next step with this OS's install guide", () => {
		for (const [platform, page] of [
			["win32", "windows"],
			["darwin", "macos"],
			["linux", "linux"],
		] as const) {
			const screen = providerChoiceScreen([], platform, { openRouterKey: true });
			expect(screen.question).toContain("No local model server is running");
			expect(screen.question).toContain(`docs/install/${page}.md`);
			expect(screen.question).toContain("docs/install/providers.md");
			expect(screen.choices.map((c) => c.value)).toEqual(["openrouter", "later"]);
		}
		expect(installGuideUrl("freebsd")).toContain("linux.md");
	});

	// #4218: Enter on this screen saved OpenRouter with no key, and the chat
	// then said "wait a moment" forever. With no key, Enter saves nothing.
	test("none found, no OpenRouter key: Enter is Decide later, and the key step is named", () => {
		const screen = providerChoiceScreen([], "darwin", { openRouterKey: false });
		expect(screen.choices.map((c) => c.value)).toEqual(["later", "openrouter"]);
		expect(screen.question).toContain("No local model server is running");
		expect(screen.question).toContain("8gent keys");
		expect(screen.question).toContain("OPENROUTER_API_KEY");
		expect(screen.question).not.toContain("Until then I can use free cloud models");
		const cloud = screen.choices.find((c) => c.value === "openrouter");
		expect(cloud?.description).toContain("keys.env");
		expect(cloud?.description).not.toContain("~/.8gent/.env");
	});

	test("missing key notice: OpenRouter without a key names the cause and the fix, never wait", () => {
		const notice = missingKeyNotice("openrouter", false);
		expect(notice).toContain("OPENROUTER_API_KEY");
		expect(notice).toContain("8gent keys");
		expect(notice).toContain("free");
		expect(notice).toContain("/provider");
		expect(notice?.toLowerCase()).not.toContain("wait");
		expect(missingKeyNotice("openrouter", true)).toBeNull();
		expect(missingKeyNotice("ollama", false)).toBeNull();
	});

	test("one found: a yes-shaped question, the server is the Enter default", async () => {
		const found = await detectLocalServers({
			env: {},
			platform: "win32",
			fetchImpl: stubFetch(LLAMA),
		});
		const screen = providerChoiceScreen(found, "win32");
		expect(screen.question).toBe(
			"I found llama-server (llama.cpp) running on this machine. Shall I use it?",
		);
		expect(screen.choices[0]).toMatchObject({ value: "llama-server" });
		expect(screen.choices[0].description).toContain("127.0.0.1:8080");
	});

	test("several found: every server is a choice, then cloud, then later", async () => {
		const found = await detectLocalServers({
			env: {},
			platform: "linux",
			fetchImpl: stubFetch({ ...LLAMA, ...LMSTUDIO }),
			ollama: OLLAMA_FOUND,
		});
		const screen = providerChoiceScreen(found, "linux");
		expect(screen.question).toContain("I found 3 local model servers");
		expect(screen.choices.map((c) => c.value)).toEqual([
			"lmstudio",
			"ollama",
			"llama-server",
			"openrouter",
			"later",
		]);
	});

	test("Ollama with the 8gent model saves that model", async () => {
		const found = await detectLocalServers({
			env: {},
			platform: "linux",
			fetchImpl: stubFetch({}),
			ollama: OLLAMA_FOUND,
		});
		expect(resolveProviderChoice("ollama", found)).toEqual({
			provider: "ollama",
			model: "eight-1.0-q3:14b",
		});
		expect(resolveProviderChoice("later", found)).toBeNull();
		expect(resolveProviderChoice("openrouter", [])).toEqual({
			provider: "openrouter",
			model: "auto:free",
		});
	});

	test("install hints carry no brew off macOS", () => {
		for (const id of ["ollama", "lmstudio"] as const) {
			expect(providerInstallHint(id, "win32")).not.toContain("brew");
			expect(providerInstallHint(id, "linux")).not.toContain("brew");
		}
		expect(providerInstallHint("ollama", "win32")).toContain("ollama.com/download/windows");
		expect(providerInstallHint("apfel", "darwin")).toContain("11435");
	});
});

describe("saving the choice", () => {
	let dir: string;
	const envAtLoad = process.env.HOME;
	beforeAll(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "onboard-choice-"));
		process.env.HOME = dir;
	});
	afterAll(() => {
		process.env.HOME = envAtLoad;
		fs.rmSync(dir, { recursive: true, force: true });
	});

	test("saveProviderChoice writes providers.json and keeps existing keys", () => {
		const file = path.join(dir, "keep.json");
		fs.writeFileSync(
			file,
			JSON.stringify({ activeProvider: "8gent", providers: { openrouter: { apiKey: "kept" } } }),
		);
		saveProviderChoice({ provider: "llama-server", model: "m.gguf" }, new ProviderManager(file));
		const saved = JSON.parse(fs.readFileSync(file, "utf-8"));
		expect(saved.activeProvider).toBe("llama-server");
		expect(saved.activeModel).toBe("m.gguf");
		expect(saved.providers["llama-server"].enabled).toBe(true);
		expect(saved.providers.openrouter.apiKey).toBe("kept");
	});

	async function walkToChoice(
		platform: string,
		arch: string,
		routes: Routes,
		providersFile: string,
	) {
		fs.rmSync(path.join(dir, ".8gent"), { recursive: true, force: true });
		const m = new OnboardingManager(dir, {
			platform,
			arch,
			env: {},
			fetchImpl: stubFetch(routes),
			ollama: Promise.resolve(OLLAMA_MISS),
			providerManager: () => new ProviderManager(providersFile),
		});
		await m.detect();
		const asked: string[] = [];
		let q = m.getNextQuestion();
		while (q && q.step !== "provider-choice") {
			asked.push(q.step);
			q = m.processAnswer(q.choices?.[0]?.value ?? "").nextQuestion;
		}
		return { m, q, asked };
	}

	test("Windows: llama-server found, picked, saved to providers.json and user.json; no apfel step", async () => {
		const file = path.join(dir, "win.json");
		const { m, q, asked } = await walkToChoice("win32", "x64", LLAMA, file);
		expect(asked).not.toContain("provider-check-apfel");
		expect(m.getTotalSteps()).toBe(
			new OnboardingManager(dir, { platform: "darwin", arch: "arm64" }).getTotalSteps() - 1,
		);
		expect(q?.choices?.[0].value).toBe("llama-server");
		m.processAnswer("llama-server");
		expect(JSON.parse(fs.readFileSync(file, "utf-8"))).toMatchObject({
			activeProvider: "llama-server",
			activeModel: "qwen3-8b-q4_k_m.gguf",
		});
		const user = JSON.parse(fs.readFileSync(path.join(dir, ".8gent", "user.json"), "utf-8"));
		expect(user.preferences.model).toMatchObject({
			provider: "llama-server",
			default: "qwen3-8b-q4_k_m.gguf",
			preferLocal: true,
		});
		expect(user.completedSteps).toContain("provider-choice");
	});

	test("nothing running: guidance shown, Decide later saves nothing", async () => {
		const file = path.join(dir, "none.json");
		const { m, q } = await walkToChoice("linux", "x64", {}, file);
		expect(q?.question).toContain("docs/install/linux.md");
		m.processAnswer("later");
		expect(fs.existsSync(file)).toBe(false);
		expect(m.getNextQuestion()?.step).not.toBe("provider-choice");
	});

	test("nothing running: free cloud models saved as openrouter auto:free", async () => {
		const file = path.join(dir, "cloud.json");
		const { m } = await walkToChoice("darwin", "arm64", {}, file);
		m.processAnswer("openrouter");
		expect(JSON.parse(fs.readFileSync(file, "utf-8"))).toMatchObject({
			activeProvider: "openrouter",
			activeModel: "auto:free",
		});
	});
});

describe("model names a person can read (#4221)", () => {
	const HASH = "llamacpp:c97eb11d70b1acdc88af01eef566c1fe4f7fbe93eb1afc06871132f293ff425a";

	test("a bare content hash is shortened and called unnamed", () => {
		expect(readableModelName(HASH)).toBe("unnamed model c97eb11d");
		expect(readableModelName("c97eb11d70b1acdc88af01eef566c1fe")).toBe("unnamed model c97eb11d");
	});

	test("named ids keep their tag and lose the registry path", () => {
		expect(readableModelName("qwen3.5:9b")).toBe("qwen3.5:9b");
		expect(readableModelName("google/gemma-4-26b-a4b")).toBe("gemma-4-26b-a4b");
	});

	test("the choice row never prints a 64-character id, and names a model the person knows", () => {
		const server = {
			id: "ollama" as const,
			label: "Ollama",
			url: "http://localhost:11434",
			models: [HASH, "qwen3.5:9b", "qwen3.8:27b-mlx"],
		};
		const line = serverModelsLine(server);
		expect(line).toBe("unnamed model c97eb11d and 2 more, including qwen3.5:9b");
		const row = providerChoiceScreen([server], "darwin").choices[0];
		expect(row.description).not.toMatch(/[0-9a-f]{32}/);
	});

	test("a named first model reads as before", () => {
		const server = {
			id: "lmstudio" as const,
			label: "LM Studio",
			url: "http://localhost:1234",
			models: ["gemma-4-26b-a4b-it"],
		};
		expect(serverModelsLine(server)).toBe("gemma-4-26b-a4b-it");
	});
});
