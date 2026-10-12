/**
 * System One must not send `8gent deck render <spec.json> [out.mp4]` to the
 * judge when both paths are inside the workspace: it is the shell door to
 * render_video_deck, and a judge call (or a card) is exactly the friction that
 * makes a local model hand-roll ffmpeg instead. The judge here is a stub that
 * answers "dangerous" to everything, so a command that reaches it is blocked.
 *
 * 8SO review of #4084: the lane must also know WHICH `8gent` the shell will
 * run. A planted ./8gent, a relative or in-workspace PATH entry, and a shim
 * whose entry script is the workspace's own bin/8gent.ts all go to the judge.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
/** An installed `8gent` outside the workspace: <outside>/bin/8gent, a shim to <outside>/pkg/bin/8gent.ts. */
let installedBin: string;
let judge: AlwaysDangerous;
const saved: Record<string, string | undefined> = {};
const KEYS = [
	SYSTEM_ONE_FLAG,
	SYSTEM_ONE_ALLOWLIST_FLAG,
	"EIGHT_HEADLESS",
	"EIGHT_WORKSPACE_ROOT",
	"PATH",
];
const SYSTEM_PATH = "/usr/bin:/bin";

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

function put(rel: string, body: string, root = ws, exec = false) {
	const abs = join(root, rel);
	mkdirSync(join(abs, ".."), { recursive: true });
	writeFileSync(abs, body);
	if (exec) chmodSync(abs, 0o755);
}

/** A shell shim named `8gent` at <dir>/8gent that runs `entry` with bun. */
function shim(dir: string, entry: string): string {
	put("8gent", `#!/bin/sh\nexec bun "${entry}" "$@"\n`, dir, true);
	return dir;
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
	// The installed 8gent: a shim outside the workspace to a source tree outside the workspace.
	put("pkg/bin/8gent.ts", "// entry\n", outside);
	installedBin = shim(join(outside, "bin"), join(outside, "pkg", "bin", "8gent.ts"));
	process.env.PATH = `${installedBin}:${SYSTEM_PATH}`;
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
const CMD = "8gent deck render deck.json out.mp4";

describe("deckRenderInProject allows the recipe the prompt shows", () => {
	for (const cmd of ALLOWED) {
		test(cmd.trim(), () => {
			const r = deckRenderInProject(cmd, ws);
			expect(r.ok, cmd).toBe(true);
		});
	}

	test("the npm launcher layout (symlink to bin/8gent-run.js, entry ../dist/cli.js), all outside", () => {
		const pkg = join(outside, "lib", "node_modules", "@8gi-foundation", "8gent-code");
		put(
			"bin/8gent-run.js",
			'#!/usr/bin/env node\nimport { join } from "node:path";\nconst cli = join(__dirname, "..", "dist", "cli.js");\n// https://bun.sh/install\n',
			pkg,
			true,
		);
		put("dist/cli.js", "// built\n", pkg);
		mkdirSync(join(outside, "bin2"));
		symlinkSync(join(pkg, "bin", "8gent-run.js"), join(outside, "bin2", "8gent"));
		const PATH = `${join(outside, "bin2")}:${SYSTEM_PATH}`;
		expect(deckRenderInProject(CMD, ws, { PATH }).ok).toBe(true);
	});
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
		expect(deckRenderInProject(CMD, undefined).ok).toBe(false);
		expect(deckRenderInProject(CMD, "proj").ok).toBe(false);
	});
});

describe("which 8gent would run (8SO, #4084)", () => {
	test("a planted ./8gent in the workspace goes to the judge, whatever PATH says", () => {
		put("8gent", "#!/bin/sh\necho pwned\n", ws, true);
		expect(deckRenderInProject(CMD, ws).ok).toBe(false);
	});

	test("a relative PATH entry goes to the judge, even with the installed 8gent after it", () => {
		for (const PATH of [
			`.:${installedBin}:${SYSTEM_PATH}`,
			`node_modules/.bin:${installedBin}`,
			`${installedBin}::${SYSTEM_PATH}`,
			`${installedBin}:bin`,
		]) {
			expect(deckRenderInProject(CMD, ws, { PATH }).ok, PATH).toBe(false);
		}
	});

	test("a PATH entry inside the workspace goes to the judge, present or not", () => {
		mkdirSync(join(ws, "node_modules", ".bin"), { recursive: true });
		for (const dir of [join(ws, "node_modules", ".bin"), join(ws, "tools"), ws]) {
			expect(
				deckRenderInProject(CMD, ws, { PATH: `${installedBin}:${dir}:${SYSTEM_PATH}` }).ok,
				dir,
			).toBe(false);
		}
	});

	test("a source checkout: bin/8gent.ts inside the workspace goes to the judge", () => {
		put("bin/8gent.ts", "// source\n");
		expect(deckRenderInProject(CMD, ws).ok).toBe(false);
	});

	test("an installed shim whose entry script is inside the workspace goes to the judge", () => {
		for (const entry of [join(ws, "bin", "8gent.ts"), join(ws, "tools", "cli.ts")]) {
			const dir = shim(join(outside, "shim"), entry);
			expect(deckRenderInProject(CMD, ws, { PATH: `${dir}:${SYSTEM_PATH}` }).ok, entry).toBe(false);
		}
		// A shim that reaches the workspace through a link, or relative to its own directory.
		symlinkSync(ws, join(outside, "ws-link"));
		for (const entry of [join(outside, "ws-link", "bin", "8gent.ts"), "../ws-link/bin/8gent.ts"]) {
			const dir = shim(join(outside, "shim"), entry);
			expect(deckRenderInProject(CMD, ws, { PATH: `${dir}:${SYSTEM_PATH}` }).ok, entry).toBe(false);
		}
	});

	test("the installed 8gent resolving inside the workspace (link or real) goes to the judge", () => {
		mkdirSync(join(outside, "linkbin"));
		put("tools/8gent", "#!/bin/sh\necho ws\n", ws, true);
		symlinkSync(join(ws, "tools", "8gent"), join(outside, "linkbin", "8gent"));
		expect(
			deckRenderInProject(CMD, ws, { PATH: `${join(outside, "linkbin")}:${SYSTEM_PATH}` }).ok,
		).toBe(false);
	});

	test("no 8gent on PATH, a non-executable one, or an empty PATH goes to the judge", () => {
		expect(deckRenderInProject(CMD, ws, { PATH: SYSTEM_PATH }).ok).toBe(false);
		expect(deckRenderInProject(CMD, ws, { PATH: "" }).ok).toBe(false);
		chmodSync(join(installedBin, "8gent"), 0o644);
		expect(deckRenderInProject(CMD, ws, { PATH: `${installedBin}:${SYSTEM_PATH}` }).ok).toBe(false);
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

	test("a planted ./8gent, a relative PATH entry, and a source checkout all reach the judge", async () => {
		put("8gent", "#!/bin/sh\necho pwned\n", ws, true);
		expect((await systemOneGate(CMD, process.env, ws)).guard?.backend).not.toBe("allowlist");
		rmSync(join(ws, "8gent"));
		const relative = { ...process.env, PATH: `.:${process.env.PATH}` };
		expect((await systemOneGate(CMD, relative, ws)).guard?.backend).not.toBe("allowlist");
		put("bin/8gent.ts", "// source\n");
		expect((await systemOneGate(CMD, process.env, ws)).guard?.backend).not.toBe("allowlist");
		// The stub judge has no calibration, so default mode checks these with the rules alone;
		// what matters is that none of them took the allowlist lane.
	});

	test("strict mode (Guarded) never skips the judge", async () => {
		process.env[SYSTEM_ONE_FLAG] = "1";
		const r = await systemOneGate(CMD, process.env, ws);
		expect(r.run).toBe(false);
		expect(r.guard?.backend).not.toBe("allowlist");
	});

	test("EIGHT_S1_ALLOWLIST=0 turns the lane off with the rest of the allowlist", async () => {
		process.env[SYSTEM_ONE_ALLOWLIST_FLAG] = "0";
		const r = await systemOneGate(CMD, process.env, ws);
		expect(r.guard?.backend).not.toBe("allowlist");
	});
});
