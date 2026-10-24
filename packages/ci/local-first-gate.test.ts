import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { installLines, runGate, shippedFiles } from "../../scripts/local-first-gate";
import { INSTALL_SITES, SINKS, type Sink } from "../../scripts/local-first-sinks";

const TODAY = "2026-10-24";

/** The shape of android-setup.ts on 8gent v0.20.26: the mic question is reached in the first-launch pass. */
const TERMUX_FIRST_RUN_ASKS = `
export async function offerAndroidSetup(mode: "auto" | "command") {
	if (mode === "auto") { /* music */ }
	if (state.mic && has(MIC_TOOL.bin)) return finish("ready");
	const yes = await ask(micAskLine(needsPkg), false);
}
const MIC_TOOL = { bin: "termux-speech-to-text", pkg: "termux-api" };
`;

/** The same file once the question is only reached when the person asked for voice. */
const TERMUX_COMMAND_ONLY = `
export async function offerAndroidSetup(mode: "auto" | "command") {
	if (mode !== "command") return "declined";
	const yes = await ask(micAskLine(needsPkg), false);
}
const MIC_TOOL = { bin: "termux-speech-to-text", pkg: "termux-api" };
`;

const sink = (over: Partial<Sink>): Sink => ({
	id: "t",
	what: "test",
	mode: "optin",
	...over,
});

function files(o: Record<string, string>): Map<string, string> {
	return new Map(Object.entries(o));
}

describe("local-first gate on this repo", () => {
	test("the tree passes: every host is listed and every guard still matches", () => {
		const r = runGate(shippedFiles(), { today: TODAY });
		expect(r.failures).toEqual([]);
	});

	test("without the known-item list, the default-path sinks fail", () => {
		const r = runGate(shippedFiles(), { today: TODAY, noWaivers: true });
		const ids = new Set(r.failures.map((f) => f.sink));
		// Whatever is still waived today must show up here, so a waiver cannot hide a sink.
		for (const s of SINKS.filter((x) => x.waiver)) expect(ids.has(s.id)).toBe(true);
	});

	test("waivers carry an issue reference and an expiry", () => {
		for (const s of SINKS.filter((x) => x.waiver)) {
			expect(s.waiver?.ref).toMatch(/#\d+/);
			expect(s.waiver?.expires).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		}
	});

	test("no two entries claim the same host", () => {
		const seen = new Map<string, string>();
		for (const s of SINKS)
			for (const h of s.hosts ?? []) {
				expect(seen.has(h) ? `${h} in ${seen.get(h)} and ${s.id}` : "ok").toBe("ok");
				seen.set(h, s.id);
			}
	});
});

describe("the Termux speech default (v0.20.26)", () => {
	const android = SINKS.find((s) => s.id === "android-speech-service") as Sink;

	test("asking the off-device voice question on first launch fails the gate", () => {
		const r = runGate(files({ "packages/eight/android-setup.ts": TERMUX_FIRST_RUN_ASKS }), {
			sinks: [{ ...android, waiver: undefined }],
			today: TODAY,
		});
		expect(r.failures.map((f) => f.rule)).toContain("guard-missing");
		expect(r.failures[0]?.sink).toBe("android-speech-service");
	});

	test("a waiver downgrades it to a known item, until it expires", () => {
		const f = files({ "packages/eight/android-setup.ts": TERMUX_FIRST_RUN_ASKS });
		const ok = runGate(f, { sinks: [android], today: TODAY });
		expect(ok.failures).toEqual([]);
		expect(ok.waived).toHaveLength(1);
		const late = runGate(f, { sinks: [android], today: "2099-01-01" });
		expect(late.failures[0]?.rule).toBe("waiver");
	});

	test("--no-waivers ignores the waiver", () => {
		const f = files({ "packages/eight/android-setup.ts": TERMUX_FIRST_RUN_ASKS });
		expect(runGate(f, { sinks: [android], today: TODAY, noWaivers: true }).failures).toHaveLength(
			1,
		);
	});

	test("reaching the question only on the command passes with no waiver", () => {
		const r = runGate(files({ "packages/eight/android-setup.ts": TERMUX_COMMAND_ONLY }), {
			sinks: [{ ...android, waiver: undefined }],
			today: TODAY,
		});
		expect(r.failures).toEqual([]);
	});

	test("removing the speech path entirely passes", () => {
		const r = runGate(files({ "packages/voice/local.ts": "export const x = 1;" }), {
			sinks: [{ ...android, waiver: undefined }],
			today: TODAY,
		});
		expect(r.failures).toEqual([]);
	});

	test("calling termux-speech-to-text from a new file fails", () => {
		const r = runGate(
			files({
				"packages/eight/android-setup.ts": TERMUX_COMMAND_ONLY,
				"packages/voice/sneaky.ts": 'spawn("termux-speech-to-text")',
			}),
			{ sinks: [{ ...android, waiver: undefined }], today: TODAY },
		);
		expect(r.failures.map((f) => f.rule)).toEqual(["new-path"]);
	});
});

describe("new sinks", () => {
	const list = [
		sink({ id: "known", mode: "pull", hosts: ["example-cdn.io"] }),
		sink({
			id: "guarded",
			hosts: ["api.vendor.io"],
			files: ["packages/x/vendor.ts"],
			optIn: [
				{ file: "packages/x/vendor.ts", mustMatch: /needs API_KEY/, how: "no key, no request" },
			],
		}),
	];

	test("a host nobody listed fails", () => {
		const r = runGate(files({ "packages/x/a.ts": 'fetch("https://telemetry.new-co.io/ping")' }), {
			sinks: list,
			today: TODAY,
		});
		expect(r.failures.map((f) => f.rule)).toEqual(["new-host"]);
		expect(r.failures[0]?.detail).toContain("telemetry.new-co.io");
	});

	test("wss and ws hosts are seen", () => {
		const r = runGate(files({ "packages/x/a.ts": 'new WebSocket("wss://stream.new-co.io/v1")' }), {
			sinks: list,
			today: TODAY,
		});
		expect(r.failures.map((f) => f.rule)).toEqual(["new-host"]);
	});

	test("this machine and example hosts are not sinks", () => {
		const r = runGate(
			files({
				"packages/x/a.ts":
					'fetch("http://localhost:11434"); fetch("http://127.0.0.1:1234"); "https://api.example.com"',
			}),
			{ sinks: list, today: TODAY },
		);
		expect(r.failures).toEqual([]);
	});

	test("a listed host reached from an unlisted file fails: it skips the guard", () => {
		const r = runGate(
			files({
				"packages/x/vendor.ts": 'needs API_KEY; fetch("https://api.vendor.io/v1")',
				"packages/y/other.ts": 'fetch("https://api.vendor.io/v1")',
			}),
			{ sinks: list, today: TODAY },
		);
		expect(r.failures.map((f) => [f.rule, f.file])).toEqual([["new-path", "packages/y/other.ts"]]);
	});

	test("deleting the guard fails", () => {
		const r = runGate(files({ "packages/x/vendor.ts": 'fetch("https://api.vendor.io/v1")' }), {
			sinks: list,
			today: TODAY,
		});
		expect(r.failures.map((f) => f.rule)).toEqual(["guard-missing"]);
	});

	test("a default-path sink fails without a waiver", () => {
		const r = runGate(files({ "packages/x/a.ts": 'fetch("https://search.co/q")' }), {
			sinks: [sink({ id: "search", mode: "default", hosts: ["search.co"] })],
			today: TODAY,
		});
		expect(r.failures.map((f) => f.rule)).toEqual(["default-sink"]);
	});

	test("a waiver with no issue reference does not count", () => {
		const r = runGate(files({ "packages/x/a.ts": 'fetch("https://search.co/q")' }), {
			sinks: [
				sink({
					id: "search",
					mode: "default",
					hosts: ["search.co"],
					waiver: { ref: "later", expires: "2026-12-01", why: "x" },
				}),
			],
			today: TODAY,
		});
		expect(r.failures.map((f) => f.rule)).toEqual(["waiver"]);
	});

	test("code outside the shipped directories is not scanned", () => {
		const f = new Map(
			[...Object.entries({ "scripts/dev.ts": 'fetch("https://anything.io")' })].filter(([k]) =>
				k.startsWith("packages/"),
			),
		);
		expect(runGate(f, { sinks: list, today: TODAY }).failures).toEqual([]);
	});
});

describe("Ollama cloud models", () => {
	test("a new reader of /api/tags that neither filters nor is reviewed fails", () => {
		const r = runGate(
			files({ "packages/x/pick.ts": "const r = await fetch(`${host}/api/tags`); models[0]" }),
			{ sinks: [], reviewedTagReaders: {}, today: TODAY },
		);
		expect(r.failures.map((f) => f.rule)).toEqual(["tags-reader"]);
	});

	test("using the shared filter passes", () => {
		const r = runGate(
			files({
				"packages/x/pick.ts":
					'import { dropOllamaCloudNames } from "../core/ollama-cloud";\nfetch(`${host}/api/tags`)',
			}),
			{ sinks: [], reviewedTagReaders: {}, today: TODAY },
		);
		expect(r.failures).toEqual([]);
	});

	test("a reviewed health check passes", () => {
		const r = runGate(files({ "packages/x/health.ts": "fetch(`${host}/api/tags`)" }), {
			sinks: [],
			reviewedTagReaders: { "packages/x/health.ts": "health" },
			today: TODAY,
		});
		expect(r.failures).toEqual([]);
	});

	test("starting ollama serve without OLLAMA_NO_CLOUD fails; with it passes", () => {
		const bad = runGate(
			files({
				"packages/eight/auto.ts": '// local-first-gate: optin\nspawn("ollama", ["serve"], { env })',
			}),
			{ sinks: [], reviewedTagReaders: {}, today: TODAY },
		);
		expect(bad.failures.map((f) => f.rule)).toEqual(["serve-env"]);
		const ok = runGate(
			files({
				"packages/eight/auto.ts":
					'// local-first-gate: optin\nspawn("ollama", ["serve"], { env: { ...env, OLLAMA_NO_CLOUD: "1" } })',
			}),
			{ sinks: [], reviewedTagReaders: {}, today: TODAY },
		);
		expect(ok.failures).toEqual([]);
	});
});

describe("one install, zero deps", () => {
	const JUDGE_OFFER =
		'export const JUDGE_OLLAMA_DOWN_LINE = "Ollama is installed but not running. Start it (ollama serve), then run /judge install.";';
	const TERMUX_PROMPT =
		'const q = `Turn on voice input (installs termux-api)? [y/N]`;\nawait installPkgs(["termux-api"]);\nsay("Run it yourself: pkg install -y termux-api");';
	const run = (f: Record<string, string>, over: Partial<Parameters<typeof runGate>[1]> = {}) =>
		runGate(files(f), {
			sinks: [],
			reviewedTagReaders: {},
			installSites: [],
			today: TODAY,
			...over,
		});

	test("the Ollama start-it text and the Termux pkg install prompt fail as new install text", () => {
		const r = run({
			"packages/eight/judge-install.ts": JUDGE_OFFER,
			"packages/eight/android-setup.ts": TERMUX_PROMPT,
		});
		expect(r.failures.map((f) => [f.rule, f.file])).toEqual([
			["new-install", "packages/eight/judge-install.ts"],
			["new-install", "packages/eight/android-setup.ts"],
		]);
	});

	test("the same text passes once it sits behind an opt-in or fallback marker", () => {
		const marked = (body: string, kind: string) =>
			body
				.split("\n")
				.map((l) => `// local-first-gate: ${kind} only after the person typed /judge install\n${l}`)
				.join("\n");
		const r = run({
			"packages/eight/judge-install.ts": marked(JUDGE_OFFER, "fallback"),
			"packages/eight/android-setup.ts": marked(TERMUX_PROMPT, "optin"),
		});
		expect(r.failures).toEqual([]);
	});

	test("each install family is seen", () => {
		for (const line of [
			'"pkg install mpv"',
			'"sudo apt install sox"',
			'"apt-get install -y nodejs"',
			'"brew install whisper-cpp"',
			'"pip install moshi"',
			'"python3 -m pip install kittentts"',
			'"npm install -g typescript-language-server"',
			'"npm i -g foo"',
			'"ollama pull qwen3:14b"',
			'"Start it with: ollama serve"',
			"fetch(`${host}/api/pull`)",
			'spawn("ollama", ["serve"])',
			'"cmake -B build"',
			'"make -j4"',
			'"xcode-select --install"',
			"await installPkgs(missing)",
		])
			expect(
				run({ "packages/x/a.ts": `const s = ${line};` }).failures.map((f) => f.rule),
			).toContain("new-install");
	});

	test("installing 8gent itself, comments, scripts and tests are not sinks", () => {
		expect(
			run({
				"packages/x/a.ts": 'const a = "npm install -g @8gi-foundation/8gent-code";',
				"packages/x/b.ts": "// brew install tmux\n/** pip install x */",
				"scripts/setup.ts": 'const s = "brew install cliclick";',
			}).failures,
		).toEqual([]);
	});

	test("a default file fails without its waiver, is known with it, fails after it expires", () => {
		const site = {
			file: "packages/eight/judge-install.ts",
			max: 1,
			mode: "default" as const,
			why: "asks to pull",
			waiver: { ref: "#4915", expires: "2026-11-07", why: "x" },
		};
		const f = { "packages/eight/judge-install.ts": JUDGE_OFFER };
		expect(run(f, { installSites: [site], noWaivers: true }).failures.map((x) => x.rule)).toEqual([
			"default-install",
		]);
		const known = run(f, { installSites: [site] });
		expect(known.failures).toEqual([]);
		expect(known.waived.map((x) => x.rule)).toEqual(["default-install"]);
		expect(
			run(f, { installSites: [site], today: "2099-01-01" }).failures.map((x) => x.rule),
		).toEqual(["waiver"]);
		expect(
			run(f, { installSites: [{ ...site, waiver: undefined }] }).failures.map((x) => x.rule),
		).toEqual(["default-install"]);
	});

	test("a default file passes once its install text is gone, and says to drop the entry", () => {
		const site = {
			file: "packages/eight/judge-install.ts",
			max: 1,
			mode: "default" as const,
			why: "asks to pull",
		};
		const r = run(
			{ "packages/eight/judge-install.ts": "export const x = 1;" },
			{ installSites: [site] },
		);
		expect(r.failures).toEqual([]);
		expect(r.warnings.join(" ")).toContain("remove the entry");
	});

	test("a reviewed fallback or opt-in file passes", () => {
		const sites = [
			{
				file: "packages/voice/recorder.ts",
				max: 1,
				mode: "fallback" as const,
				why: "recording was requested",
			},
			{ file: "packages/music/dj.ts", max: 1, mode: "optin" as const, why: "/dj and a yes" },
		];
		expect(
			run(
				{
					"packages/voice/recorder.ts": '"brew install sox"',
					"packages/music/dj.ts": '"brew install mpv"',
				},
				{ installSites: sites },
			).failures,
		).toEqual([]);
	});

	test("on this tree every install-text file is accounted for, and the defaults are known items", () => {
		const r = runGate(shippedFiles(), { today: TODAY });
		expect(r.failures).toEqual([]);
		expect(r.waived.some((w) => w.rule === "default-install")).toBe(true);
		const strict = runGate(shippedFiles(), { today: TODAY, noWaivers: true });
		expect(strict.failures.filter((f) => f.rule === "default-install").length).toBeGreaterThan(0);
	});
});

describe("install gate: second-read holes", () => {
	const run = (f: Record<string, string>, over: Partial<Parameters<typeof runGate>[1]> = {}) =>
		runGate(files(f), {
			sinks: [],
			reviewedTagReaders: {},
			installSites: [],
			today: TODAY,
			...over,
		});
	const rules = (r: ReturnType<typeof runGate>) => r.failures.map((f) => f.rule);

	test("1. only the 8gent package is exempt, not any line that mentions 8gent-code, ${file} or ${spec}", () => {
		expect(
			rules(
				run({
					"packages/x/a.ts": 'const a = "npm install -g @8gi-foundation/8gent-code --force";',
				}),
			),
		).toEqual([]);
		for (const line of [
			"const a = `pip install ${file}`; // 8gent-code",
			"const a = `npm install -g ${spec}`;",
			"const a = `brew install ${file}`;",
			'const a = "pkg install 8gent-code-helper";',
			'const a = "npm install -g @evil/8gent-code";',
		])
			expect(rules(run({ "packages/x/a.ts": line }))).toContain("new-install");
	});

	test("1b. self-update installs 8gent itself behind markers, so the real file is clean", () => {
		const text = readFileSync(join(import.meta.dir, "../eight/self-update.ts"), "utf8");
		expect(installLines(text)).toEqual([]);
	});

	test("2. a listed file may not grow: a new unmarked install line fails, fewer warns", () => {
		const site = {
			file: "packages/voice/termux.ts",
			max: 1,
			mode: "fallback" as const,
			why: "recording requested",
		};
		const one = 'const a = "pkg install termux-api";';
		expect(rules(run({ "packages/voice/termux.ts": one }, { installSites: [site] }))).toEqual([]);
		const two = `${one}\nconst b = "pkg install ffmpeg";`;
		const grown = run({ "packages/voice/termux.ts": two }, { installSites: [site] });
		expect(rules(grown)).toEqual(["new-install"]);
		expect(grown.failures[0]?.detail).toContain("2");
		const none = run({ "packages/voice/termux.ts": "const a = 1;" }, { installSites: [site] });
		expect(none.warnings.join(" ")).toContain("max");
	});

	test("2b. a marked line does not count against the pin", () => {
		const site = { file: "packages/voice/termux.ts", mode: "fallback" as const, max: 1, why: "x" };
		const text =
			'const a = "pkg install termux-api";\n// local-first-gate: fallback x\nconst b = "pkg install ffmpeg";';
		expect(rules(run({ "packages/voice/termux.ts": text }, { installSites: [site] }))).toEqual([]);
	});

	test("3. a star-prefixed line inside a string is code; a real comment is not", () => {
		const inString = "const help = `\n * brew install ollama\n`;";
		expect(rules(run({ "packages/x/a.ts": inString }))).toEqual(["new-install"]);
		expect(
			rules(run({ "packages/x/b.ts": "/**\n * brew install tmux\n */\nconst a = 1;" })),
		).toEqual([]);
		expect(
			rules(run({ "packages/x/c.ts": "// brew install tmux\n/* pip install x */\nconst a = 1;" })),
		).toEqual([]);
		expect(
			rules(run({ "packages/x/d.ts": "/*\n pkg install a\n*/ const b = 'pkg install c';" })),
		).toEqual(["new-install"]);
	});

	test("4. a marker reaches its own line and the line directly below only", () => {
		const m = "// local-first-gate: fallback x\n";
		expect(rules(run({ "packages/x/a.ts": `${m}const s = "brew install tmux";` }))).toEqual([]);
		expect(
			rules(
				run({
					"packages/x/a.ts": `const s = "brew install tmux"; // local-first-gate: fallback x`,
				}),
			),
		).toEqual([]);
		expect(
			rules(run({ "packages/x/a.ts": `${m}const a = 1;\nconst s = "brew install tmux";` })),
		).toEqual(["new-install"]);
		expect(
			rules(
				run({ "packages/x/a.ts": `${m}const s = "brew install a";\nconst t = "brew install b";` }),
			),
		).toEqual(["new-install"]);
	});

	test("5. only the repo-root scripts/ is skipped, not packages/*/scripts/", () => {
		expect(rules(run({ "scripts/setup.ts": 'const s = "brew install cliclick";' }))).toEqual([]);
		expect(
			rules(run({ "packages/eight/scripts/setup.ts": 'const s = "brew install cliclick";' })),
		).toEqual(["new-install"]);
		expect(
			rules(run({ "apps/tui/scripts/setup.ts": 'const s = "brew install cliclick";' })),
		).toEqual(["new-install"]);
	});

	test("every install site pins a count", () => {
		for (const x of INSTALL_SITES) expect(Number.isInteger(x.max) && x.max > 0).toBe(true);
	});
});
