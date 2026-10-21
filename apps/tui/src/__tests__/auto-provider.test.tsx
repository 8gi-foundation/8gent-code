/**
 * #4720, end to end through the real App, in its own process, against a fake
 * MiniMax endpoint served here. A MiniMax key, no Ollama, no LM Studio:
 *  - the first task runs on MiniMax with no /provider step, one line says why;
 *  - /status names the provider, the model and that it answers;
 *  - the choice is on disk, and a second launch starts on it even when the
 *    local default is up;
 *  - the /provider picker, on a 52-column terminal, lists the keyed provider
 *    first, says the active local one is not reachable, closes on selection and
 *    opens the model list once.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as path from "node:path";
import { runAppHarness } from "./app-driver.js";

const MODEL = "MiniMax-fake-live-9";
const DEAD = "http://127.0.0.1:9";
let server: ReturnType<typeof Bun.serve>;
let env: Record<string, string>;

beforeAll(() => {
	server = Bun.serve({
		port: 0,
		fetch(req) {
			const url = new URL(req.url);
			if (url.pathname.endsWith("/models"))
				return Response.json({ object: "list", data: [{ id: MODEL, object: "model" }] });
			return new Response("not found", { status: 404 });
		},
	});
	env = {
		MINIMAX_BASE_URL: `http://127.0.0.1:${server.port}/v1`,
		// A placeholder, never a real key: the endpoint is the fake above.
		MINIMAX_API_KEY: "test-placeholder-not-a-key",
		OLLAMA_BASE_URL: DEAD,
		OLLAMA_HOST: DEAD,
		EIGHT_DECIDE_OLLAMA_HOST: DEAD,
		LM_STUDIO_HOST: DEAD,
		SWITCH_MODEL: MODEL,
	};
});
afterAll(() => server.stop(true));

const dir = import.meta.dir;
const one = (events: Record<string, unknown>[], phase: string) =>
	events.find((e) => e.phase === phase) as Record<string, unknown> | undefined;

describe("a MiniMax key and no Ollama (#4720)", () => {
	test("the first task runs on MiniMax with no /provider step; /status says so; the choice is saved", async () => {
		const events = await runAppHarness(path.join(dir, "auto-provider.harness.tsx"), {
			...env,
			HARNESS_COLS: "120",
		});
		expect(one(events, "error")).toBeUndefined();
		const r = one(events, "auto");
		expect(r?.line).toMatch(
			new RegExp(`is not running; using MiniMax ${MODEL}\\. /provider to change\\.`),
		);
		expect(r?.pickerShown).toBeFalse();
		expect(r?.notReady).toBeFalse();
		expect(r?.noModelCard).toBeFalse();
		expect(String(r?.statusLine).replace(/\s+/g, " ")).toContain(
			`Provider: MiniMax (minimax), model ${MODEL}, reachable`,
		);
		expect(r?.saved).toEqual({ provider: "minimax", model: MODEL });
	}, 120_000);

	test("a second launch starts on the saved provider even with the local default up", async () => {
		const events = await runAppHarness(path.join(dir, "saved-provider.harness.tsx"), {
			MINIMAX_BASE_URL: env.MINIMAX_BASE_URL,
			MINIMAX_API_KEY: env.MINIMAX_API_KEY,
			LM_STUDIO_HOST: DEAD,
			SAVED_MODEL: MODEL,
			HARNESS_COLS: "120",
		});
		expect(one(events, "error")).toBeUndefined();
		const r = one(events, "relaunch");
		expect(r?.statusLine).toBe(`Provider: MiniMax (minimax), model ${MODEL}, reachable`);
		expect(r?.onLocal).toBeFalse();
	}, 120_000);

	test("a saved hosted provider with no saved model still wins, and its live list picks the model", async () => {
		const events = await runAppHarness(path.join(dir, "saved-provider.harness.tsx"), {
			MINIMAX_BASE_URL: env.MINIMAX_BASE_URL,
			MINIMAX_API_KEY: env.MINIMAX_API_KEY,
			LM_STUDIO_HOST: DEAD,
			SAVED_MODEL: "",
			HARNESS_COLS: "120",
		});
		expect(one(events, "error")).toBeUndefined();
		expect(one(events, "relaunch")?.statusLine).toBe(
			`Provider: MiniMax (minimax), model ${MODEL}, reachable`,
		);
	}, 120_000);

	test("the picker on a 52-column terminal: keyed first, closes on selection, model list opens once", async () => {
		const events = await runAppHarness(path.join(dir, "provider-picker.harness.tsx"), {
			...env,
			HARNESS_COLS: "52",
			HARNESS_ROWS: "34",
		});
		expect(one(events, "error")).toBeUndefined();
		const r = one(events, "picker");
		expect(r?.opened).toBeTrue();
		const rows = r?.firstRowsMiniMaxBeforeOllamaDown as { minimax: number; ollama: number };
		expect(rows.minimax).toBeGreaterThan(-1);
		expect(rows.minimax).toBeLessThan(rows.ollama);
		expect(r?.activeNotReachable).toBeTrue();
		expect(r?.stillOpen).toBeFalse();
		expect(r?.modelListOpened).toBeTrue();
		// The filter word typed in the picker is not a message to the model.
		expect(r?.filterLeakedAsMessage).toBeFalse();
	}, 120_000);
});
