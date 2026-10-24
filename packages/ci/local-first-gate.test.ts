import { describe, expect, test } from "bun:test";
import { runGate, shippedFiles } from "../../scripts/local-first-gate";
import { SINKS, type Sink } from "../../scripts/local-first-sinks";

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
			files({ "packages/eight/auto.ts": 'spawn("ollama", ["serve"], { env })' }),
			{ sinks: [], reviewedTagReaders: {}, today: TODAY },
		);
		expect(bad.failures.map((f) => f.rule)).toEqual(["serve-env"]);
		const ok = runGate(
			files({
				"packages/eight/auto.ts":
					'spawn("ollama", ["serve"], { env: { ...env, OLLAMA_NO_CLOUD: "1" } })',
			}),
			{ sinks: [], reviewedTagReaders: {}, today: TODAY },
		);
		expect(ok.failures).toEqual([]);
	});
});
