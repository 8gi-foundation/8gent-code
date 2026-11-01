/**
 * Second read of #4861: a loopback 8J server that answers 3xx must not hand the command to
 * another server. Through the real systemOneGate, createDecider and probe: the loopback fake
 * redirects (302, 307, 308) to a second server that would say "allow" (noul 0.0). The verdict
 * must be escalate and the second server must receive nothing.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDecider } from "../decide/index";
import { _resetSystemOne, _setSystemOneOverridesForTests, systemOneGate } from "./system-one-gate";

const MODEL = "8j-redirect-test";
const COMMAND = "make build";

/** Hits on the second server, by path. */
let elsewhereHits: string[] = [];
/** What the loopback fake does: answer itself, or redirect POSTs or every path. */
let redirect: { status: 302 | 307 | 308; paths: "post" | "all" } | null = null;

const answer = (body: { questions: Record<string, unknown> }) =>
	Response.json({
		model: MODEL,
		answers: Object.fromEntries(
			Object.keys(body.questions).map((id) => [id, { type: "noul", noul: 0 }]),
		),
	});

let elsewhere: ReturnType<typeof Bun.serve>;
let loopback: ReturnType<typeof Bun.serve>;
let calibrationDir: string;

beforeAll(() => {
	elsewhere = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(req) {
			const path = new URL(req.url).pathname;
			elsewhereHits.push(path);
			if (path === "/health") return Response.json({ ok: true, model: MODEL });
			return answer(await req.json());
		},
	});
	loopback = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(req) {
			const path = new URL(req.url).pathname;
			if (redirect && (redirect.paths === "all" || req.method === "POST"))
				return Response.redirect(`http://127.0.0.1:${elsewhere.port}${path}`, redirect.status);
			if (path === "/health") return Response.json({ ok: true, model: MODEL });
			return answer(await req.json());
		},
	});
	// Calibrated, so default mode really asks the judge (uncalibrated would escalate first).
	calibrationDir = mkdtempSync(join(tmpdir(), "s1-8j-redirect-"));
	writeFileSync(
		join(calibrationDir, `8j-${MODEL}.json`),
		JSON.stringify({
			model: MODEL,
			backend: "8j",
			fittedOn: "test",
			n: 0,
			temperature: 1,
			bias: 0,
			blockAbove: 0.5,
			escalateBand: [0.05, 0.5],
			heldOut: { recall: 1, falseBlock: 0, accuracy: 1, escalate: 0, method: "leave-one-out" },
		}),
	);
});

afterAll(() => {
	elsewhere.stop(true);
	loopback.stop(true);
	rmSync(calibrationDir, { recursive: true, force: true });
});

afterEach(() => {
	_resetSystemOne();
	elsewhereHits = [];
	redirect = null;
});

async function gate(extra: Record<string, string> = {}) {
	const env = {
		EIGHT_8J_URL: `http://127.0.0.1:${loopback.port}`,
		EIGHT_SYSTEM_ONE_ALLOWLIST: "0",
		HOME: tmpdir(),
		...extra,
	};
	const asked: string[] = [];
	_setSystemOneOverridesForTests({
		createDecider: () => createDecider({ env, llamacppLoader: null, cacheSize: 0 }),
		askHuman: async (req) => {
			asked.push(req.command);
			return null;
		},
		calibrationDir,
	});
	return { r: await systemOneGate(COMMAND, env), asked };
}

describe("8j judge behind a redirect", () => {
	test("control: no redirect, the calibrated judge is asked and allows", async () => {
		const { r } = await gate();
		expect(r.run).toBe(true);
		expect(r.guard).toMatchObject({ verdict: "allow", backend: "8j" });
	});

	for (const status of [302, 307, 308] as const) {
		for (const mode of ["default", "strict"] as const) {
			test(`${status} on POST /v1/systemone, ${mode} mode: escalate, nothing sent on`, async () => {
				redirect = { status, paths: "post" };
				const { r, asked } = await gate(mode === "strict" ? { EIGHT_SYSTEM_ONE: "1" } : {});
				expect(r.run).toBe(false);
				expect(r.guard?.verdict).toBe("escalate");
				expect(asked).toEqual([COMMAND]);
				expect(elsewhereHits).toEqual([]);
			});
		}
	}

	test("307 on /health too: no judge, escalate, nothing sent on", async () => {
		redirect = { status: 307, paths: "all" };
		const { r, asked } = await gate();
		expect(r.run).toBe(false);
		expect(r.guard?.verdict).toBe("escalate");
		expect(asked).toEqual([COMMAND]);
		expect(elsewhereHits).toEqual([]);
	});
});
