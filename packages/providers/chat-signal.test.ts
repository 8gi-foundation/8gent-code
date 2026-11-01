/**
 * #3541: ChatRequest.signal reaches the model fetch.
 *
 * A caller abort must tear down the upstream HTTP request and surface as an
 * abort, not as a TurnTimeoutError (which the failover loop would treat as a
 * dead provider). Fake upstream on 127.0.0.1, port 0, no model.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TurnTimeoutError } from "../eight/turn-timeout";
import { ProviderManager } from "./index";

let tmp: string;
let upstream: ReturnType<typeof Bun.serve>;
let sawAbort: Promise<void>;
let markAbort: () => void;
let sawRequest: Promise<void>;
let markRequest: () => void;

beforeAll(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "chat-signal-"));
});

afterEach(() => upstream?.stop(true));

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function startStallingUpstream() {
	sawAbort = new Promise<void>((r) => (markAbort = r));
	sawRequest = new Promise<void>((r) => (markRequest = r));
	upstream = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		idleTimeout: 0,
		fetch(req) {
			markRequest();
			return new Promise<Response>((resolve) => {
				req.signal.addEventListener("abort", () => {
					markAbort();
					resolve(new Response("gone", { status: 499 }));
				});
			});
		},
	});
	return `http://127.0.0.1:${upstream.port}`;
}

function manager(kind: "ollama" | "lmstudio", base: string): ProviderManager {
	const file = path.join(tmp, `${kind}.json`);
	const providers =
		kind === "ollama"
			? { ollama: { enabled: true, baseUrl: base } }
			: { lmstudio: { enabled: true, baseUrl: `${base}/v1` } };
	fs.writeFileSync(file, JSON.stringify({ activeProvider: kind, activeModel: "fake", providers }));
	return new ProviderManager(file);
}

for (const kind of ["ollama", "lmstudio"] as const) {
	describe(`ProviderManager.chat signal (${kind})`, () => {
		test("an abort cancels the upstream request and rejects as an abort", async () => {
			const pm = manager(kind, startStallingUpstream());
			const ac = new AbortController();
			const call = pm.chat({ messages: [{ role: "user", content: "hi" }], signal: ac.signal });
			// Abort only once the request is in flight upstream.
			await sawRequest;
			ac.abort();

			const err = await call.then(
				() => null,
				(e: unknown) => e,
			);
			expect(err).not.toBeNull();
			expect(err).not.toBeInstanceOf(TurnTimeoutError);
			expect((err as Error).name).toBe("AbortError");
			await Promise.race([
				sawAbort,
				new Promise((_, rej) =>
					setTimeout(() => rej(new Error("upstream never saw abort")), 2_000),
				),
			]);
		}, 10_000);
	});
}
