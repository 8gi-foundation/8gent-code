/**
 * Hardening from the second read of #4861: no judge backend follows a redirect. A loopback
 * server that answers 307 must not get the prompt (which carries the command) re-sent to the
 * server it points at. Ollama (the 8gate path) and laya, through the real bashGuard with the
 * real fetch.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { bashGuard } from "../guard";
import { createDecider } from "../index";
import { LayaBackend } from "./laya";
import { OllamaBackend } from "./ollama";

let elsewhereHits: string[] = [];
let elsewhere: ReturnType<typeof Bun.serve>;
let loopback: ReturnType<typeof Bun.serve>;

beforeAll(() => {
	// Would answer "allow" in both shapes if anything reached it.
	elsewhere = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(req) {
			elsewhereHits.push(new URL(req.url).pathname);
			return Response.json({
				logprobs: [{ top_logprobs: [{ token: "no", logprob: 0 }] }],
				answers: [{ id: "q", probabilities: { yes: 0 } }],
			});
		},
	});
	loopback = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(req) {
			const path = new URL(req.url).pathname;
			return Response.redirect(`http://127.0.0.1:${elsewhere.port}${path}`, 307);
		},
	});
});

afterAll(() => {
	elsewhere.stop(true);
	loopback.stop(true);
});

afterEach(() => {
	elsewhereHits = [];
});

describe("judge backends never follow a redirect", () => {
	test("ollama /api/generate: block, nothing sent on", async () => {
		const backend = new OllamaBackend({
			host: `http://127.0.0.1:${loopback.port}`,
			model: "judge",
		});
		const r = await bashGuard("make build", createDecider({ backend, cacheSize: 0 }));
		expect(r.verdict).toBe("block");
		expect(r.backend).toBe("unavailable");
		expect(elsewhereHits).toEqual([]);
	});

	test("laya /v1/systemone: block, nothing sent on", async () => {
		const backend = new LayaBackend({ url: `http://127.0.0.1:${loopback.port}` });
		const r = await bashGuard("make build", createDecider({ backend, cacheSize: 0 }));
		expect(r.verdict).toBe("block");
		expect(r.backend).toBe("unavailable");
		expect(elsewhereHits).toEqual([]);
	});
});
