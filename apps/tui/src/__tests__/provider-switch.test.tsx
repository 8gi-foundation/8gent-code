/**
 * #4682: /provider to a hosted provider froze the Node-build TUI on a phone. The TUI ran
 * a copy of its own runtime (the local-model probe, process.execPath -e) synchronously;
 * and right after the switch, before the live list landed, it said the list had no models.
 * The real App, in its own process, against a fake MiniMax endpoint served here.
 */
import { expect, test } from "bun:test";
import * as path from "node:path";
import { runAppHarness } from "./app-driver.js";

const MODEL = "MiniMax-fake-switch-7";

test("/provider minimax picks a model from the live list, and the TUI never starts itself", async () => {
	const lists: string[] = [];
	const server = Bun.serve({
		port: 0,
		fetch(req) {
			const url = new URL(req.url);
			if (url.pathname.endsWith("/models")) {
				lists.push(req.headers.get("authorization") ?? "");
				return Response.json({ object: "list", data: [{ id: MODEL, object: "model" }] });
			}
			return new Response("not found", { status: 404 });
		},
	});
	try {
		const events = await runAppHarness(path.join(import.meta.dir, "provider-switch.harness.tsx"), {
			MINIMAX_BASE_URL: `http://127.0.0.1:${server.port}/v1`,
			// A placeholder, never a real key: the endpoint is the fake above.
			MINIMAX_API_KEY: "test-placeholder-not-a-key",
			SWITCH_MODEL: MODEL,
		});
		expect(events.find((e) => e.phase === "error")).toBeUndefined();
		const boot = events.find((e) => e.phase === "boot");
		const sw = events.find((e) => e.phase === "switch");
		expect(boot?.self).toEqual([]);
		expect(sw?.self).toEqual([]);
		expect(sw?.picked).toBeTrue();
		expect(sw?.noModelsNotice).toBeFalse();
		expect(sw?.notReady).toBeFalse();
		// The list came from the endpoint, with the key.
		expect(lists.length).toBeGreaterThan(0);
		expect(lists[0]).toBe("Bearer test-placeholder-not-a-key");
	} finally {
		server.stop(true);
	}
}, 90_000);
