/**
 * System One must not send `8gent deck render <spec.json> [out.mp4]` to the
 * judge when both paths are inside the workspace: it is the shell door to
 * render_video_deck, and a judge call (or a card) is exactly the friction that
 * makes a local model hand-roll ffmpeg instead. The judge here is a stub that
 * answers "dangerous" to everything, so a command that reaches it is blocked.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDirs, tempDir } from "../../tests/temp-dirs";
import { createDecider } from "../decide/index";
import type { DecideBackend, SystemOneRequest, SystemOneResponse } from "../decide/types";
import { deckRenderInProject } from "./s1-deck-render";
import {
	SYSTEM_ONE_ALLOWLIST_FLAG,
	SYSTEM_ONE_FLAG,
	_resetSystemOne,
	_setSystemOneOverridesForTests,
	systemOneGate,
} from "./system-one-gate";

afterAll(cleanupTempDirs);

class AlwaysDangerous implements DecideBackend {
	readonly name = "stub";
	readonly model = "always-dangerous";
	asks = 0;
	async ask(request: SystemOneRequest): Promise<SystemOneResponse> {
		this.asks++;
		return {
			answers: [
				{
					id: request.questions[0].id,
					kind: "noul",
					probabilities: { yes: 0.99 },
					confidence: 0.99,
				},
			],
			backend: this.name,
			model: this.model,
			latencyMs: 0,
		};
	}
}

let ws: string;
let outside: string;
let judge: AlwaysDangerous;
const saved: Record<string, string | undefined> = {};
const KEYS = [SYSTEM_ONE_FLAG, SYSTEM_ONE_ALLOWLIST_FLAG, "EIGHT_HEADLESS", "EIGHT_WORKSPACE_ROOT"];

beforeAll(() => {
	for (const k of KEYS) saved[k] = process.env[k];
	Reflect.deleteProperty(process.env, "EIGHT_WORKSPACE_ROOT");
	Reflect.deleteProperty(process.env, SYSTEM_ONE_ALLOWLIST_FLAG);
	Reflect.deleteProperty(process.env, SYSTEM_ONE_FLAG);
	process.env.EIGHT_HEADLESS = "1";
});

afterAll(() => {
	for (const k of KEYS) {
		if (saved[k] === undefined) Reflect.deleteProperty(process.env, k);
		else process.env[k] = saved[k];
	}
	_resetSystemOne();
});

function put(rel: string, body: string, root = ws) {
	const abs = join(root, rel);
	mkdirSync(join(abs, ".."), { recursive: true });
	writeFileSync(abs, body);
}

beforeEach(() => {
	ws = realpathSync.native(tempDir("s1-deck-ws-"));
	outside = realpathSync.native(tempDir("s1-deck-out-"));
	put("deck.json", "{}");
	put("sub/deck.json", "{}");
	put(".tmp/deck.json", "{}");
	put(".hidden/deck.json", "{}");
	put("notes.txt", "x");
	put("packages/permissions/gate.ts", "export const x = 1;\n");
	mkdirSync(join(ws, "hooks"));
	mkdirSync(join(ws, "video"));
	mkdirSync(join(ws, "adir.mp4"));
	writeFileSync(join(outside, "deck.json"), "{}");
	symlinkSync(join(outside, "deck.json"), join(ws, "linked.json"));
	symlinkSync(outside, join(ws, "escape"));
	symlinkSync(join(outside, "x.mp4"), join(ws, "linked.mp4"));
	judge = new AlwaysDangerous();
	_setSystemOneOverridesForTests({
		createDecider: () => createDecider({ backend: judge, cacheSize: 0 }),
		askHuman: async () => null,
		calibrationDir: tempDir("s1-deck-nocal-"),
	});
});

afterEach(() => {
	rmSync(ws, { recursive: true, force: true });
	rmSync(outside, { recursive: true, force: true });
	Reflect.deleteProperty(process.env, SYSTEM_ONE_ALLOWLIST_FLAG);
	Reflect.deleteProperty(process.env, SYSTEM_ONE_FLAG);
});

const ALLOWED = [
	"8gent deck render deck.json",
	"8gent deck render deck.json video/brief.mp4",
	"8gent deck render ./deck.json out.mp4",
	"8gent deck render sub/deck.json sub/out.mp4",
	"8gent deck render .tmp/deck.json .tmp/out.mp4",
	"  8gent deck render deck.json new/dir/out.mp4  ",
];

describe("deckRenderInProject allows the recipe the prompt shows", () => {
	for (const cmd of ALLOWED) {
		test(cmd.trim(), () => {
			const r = deckRenderInProject(cmd, ws);
			expect(r.ok, cmd).toBe(true);
		});
	}
});

describe("deckRenderInProject has no opinion on anything else", () => {
	const refused = (): string[] => [
		// not this command
		"8gent deck",
		"8gent deck render",
		"8gent deck list deck.json",
		"8gent run deck.json",
		"bun bin/8gent.ts deck render deck.json",
		"8 deck render deck.json",
		"X=1 8gent deck render deck.json",
		"8gent --infinite deck render deck.json",
		"8gent deck render --out out.mp4 deck.json",
		"8gent deck render deck.json out.mp4 extra",
		// shell structure
		"8gent deck render deck.json | cat",
		"8gent deck render deck.json && rm -rf .",
		"8gent deck render deck.json; ls",
		"8gent deck render deck.json > out.txt",
		"8gent deck render `ls`.json",
		"8gent deck render $HOME/deck.json",
		"8gent deck render ~/deck.json",
		"8gent deck render 'deck.json'",
		"8gent deck render deck.json\nls",
		// spec not a plain json file inside the workspace
		"8gent deck render missing.json",
		"8gent deck render notes.txt",
		"8gent deck render deck.JSON.bak",
		"8gent deck render linked.json",
		"8gent deck render escape/deck.json",
		"8gent deck render ../deck.json",
		"8gent deck render .hidden/deck.json",
		"8gent deck render sub/../deck.json",
		"8gent deck render sub/./deck.json",
		"8gent deck render video",
		`8gent deck render ${ws}/deck.json`,
		`8gent deck render ${outside}/deck.json`,
		// out not a plain mp4 path inside the workspace
		"8gent deck render deck.json ../out.mp4",
		"8gent deck render deck.json escape/out.mp4",
		"8gent deck render deck.json linked.mp4",
		"8gent deck render deck.json adir.mp4",
		"8gent deck render deck.json out.mov",
		"8gent deck render deck.json out.mp4/",
		"8gent deck render deck.json .git/out.mp4",
		"8gent deck render deck.json .hidden/out.mp4",
		"8gent deck render deck.json hooks/out.mp4",
		"8gent deck render deck.json packages/permissions/out.mp4",
		"8gent deck render deck.json .env.mp4",
		`8gent deck render deck.json ${ws}/out.mp4`,
		`8gent deck render deck.json ${outside}/out.mp4`,
	];
	test("every shape above falls through to the judge", () => {
		for (const cmd of refused())
			expect(deckRenderInProject(cmd, ws).ok, JSON.stringify(cmd)).toBe(false);
	});

	test("no working directory, or a relative one, is no opinion", () => {
		expect(deckRenderInProject("8gent deck render deck.json", undefined).ok).toBe(false);
		expect(deckRenderInProject("8gent deck render deck.json", "proj").ok).toBe(false);
	});
});

describe("systemOneGate end to end (default mode) with a judge that says dangerous", () => {
	test("the recipe runs without asking the judge", async () => {
		for (const cmd of ALLOWED) {
			const r = await systemOneGate(cmd, process.env, ws);
			expect(r.run, cmd).toBe(true);
			expect(r.guard?.backend, cmd).toBe("allowlist");
			expect(r.guard?.reason, cmd).toContain("8gent deck render");
		}
		expect(judge.asks).toBe(0);
	});

	for (const cmd of [
		"8gent deck render ../deck.json",
		"8gent deck render linked.json",
		"8gent deck render deck.json escape/out.mp4",
		"8gent deck render deck.json && rm -rf .",
		"bun bin/8gent.ts deck render deck.json",
	]) {
		test(`never the allowlist lane: ${cmd}`, async () => {
			const r = await systemOneGate(cmd, process.env, ws);
			expect(r.guard?.backend).not.toBe("allowlist");
		});
	}

	test("strict mode (Guarded) never skips the judge", async () => {
		process.env[SYSTEM_ONE_FLAG] = "1";
		const r = await systemOneGate("8gent deck render deck.json out.mp4", process.env, ws);
		expect(r.run).toBe(false);
		expect(r.guard?.backend).not.toBe("allowlist");
	});

	test("EIGHT_S1_ALLOWLIST=0 turns the lane off with the rest of the allowlist", async () => {
		process.env[SYSTEM_ONE_ALLOWLIST_FLAG] = "0";
		const r = await systemOneGate("8gent deck render deck.json out.mp4", process.env, ws);
		expect(r.guard?.backend).not.toBe("allowlist");
	});
});
