/**
 * System One must not send a plain `magick`/`convert` render to the judge when it draws only from
 * built-in generators into an image file inside the workspace (#4177). Real task artale-overnight
 * (13 Oct 2026): seven such renders of slide frames were blocked or escalated by the judge at pYes
 * 0.35 to 0.43, and the task stalled. The judge here is a stub that answers "dangerous" to
 * everything, so a command that reaches it is blocked.
 *
 * Every escape the 8SO ruling names is probed: an output outside the root, each coder that reads a
 * file or the network, `@` lists and `label:@`-style reads, `-script`, `-write` outside the root, a
 * symlinked output folder, a hardlinked output, an in-line variable, and ImageMagick configuration
 * or a `magick` binary planted in the workspace. None of them takes the lane.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	linkSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { cleanupTempDirs, tempDir } from "../../tests/temp-dirs";
import { createDecider } from "../decide/index";
import type { DecideBackend, SystemOneRequest, SystemOneResponse } from "../decide/types";
import { magickRenderInProject, strictWords } from "./s1-magick";
import { checkCommandBoundary } from "./src/workspace-boundary";
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

/** The lane's grammar is POSIX; on win32 it has no opinion and everything goes to the judge. */
const LANE = process.platform !== "win32";
const SYSTEM_PATH = "/usr/bin:/bin";

let ws: string;
let outside: string;
let env: Record<string, string | undefined>;
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
	ws = realpathSync.native(tempDir("s1-magick-ws-"));
	outside = realpathSync.native(tempDir("s1-magick-out-"));
	mkdirSync(join(ws, ".tmp", "overnight", "frames"), { recursive: true });
	mkdirSync(join(ws, "sub"));
	mkdirSync(join(ws, "adir.png"));
	mkdirSync(join(outside, "home"));
	put("old.png", "png");
	put("list.txt", "/etc/passwd\n");
	put("list.txt", "/etc/passwd\n", outside);
	symlinkSync(outside, join(ws, "escape"));
	env = { PATH: SYSTEM_PATH, HOME: join(outside, "home") };
	judge = new AlwaysDangerous();
	_setSystemOneOverridesForTests({
		createDecider: () => createDecider({ backend: judge, cacheSize: 0 }),
		askHuman: async () => null,
		calibrationDir: tempDir("s1-magick-nocal-"),
	});
});

afterEach(() => {
	rmSync(ws, { recursive: true, force: true });
	rmSync(outside, { recursive: true, force: true });
	Reflect.deleteProperty(process.env, SYSTEM_ONE_ALLOWLIST_FLAG);
	Reflect.deleteProperty(process.env, SYSTEM_ONE_FLAG);
});

const ok = (cmd: string, cwd = ws, e = env, project?: string) =>
	magickRenderInProject(cmd, cwd, e, project).ok;

// ---------------------------------------------------------------------------
// The evidence: artale-overnight, 13 Oct 2026
// ---------------------------------------------------------------------------

type Call = { step: number; blockedBy: string; command: string };
const FIXTURE: { calls: Call[] } = JSON.parse(
	readFileSync(
		join(import.meta.dir, "__tests__", "fixtures", "artale-overnight-magick.json"),
		"utf8",
	),
);
const at = (c: Call) => c.command.replaceAll("{WS}", ws);
const S1_BLOCKED = FIXTURE.calls.filter((c) => c.blockedBy === "[SYSTEM ONE BLOCKED]");

/** The verbatim run, when this machine has it; CI runs the fixture above (slide text redacted). */
const EVIDENCE = join(homedir(), ".8gent/evidence/real-tasks/2026-10-13/artale-overnight");
const EVIDENCE_WS = `${EVIDENCE}/work`;
function verbatim(): string[] {
	const uses = new Map<string, { step: number; command: string }>();
	const blocked = new Set<string>();
	for (const line of readFileSync(join(EVIDENCE, "stream.jsonl"), "utf8").split("\n")) {
		if (!line.trim()) continue;
		const d = JSON.parse(line);
		if (d.type === "tool_use" && d.tool_name === "run_command")
			uses.set(d.tool_call_id, { step: d.step, command: d.input.command });
		if (d.type === "tool_result" && String(d.result_preview).startsWith("[SYSTEM ONE BLOCKED]"))
			blocked.add(d.tool_call_id);
	}
	return [...uses.entries()]
		.filter(([id, u]) => blocked.has(id) && u.command.startsWith("magick "))
		.map(([, u]) => u.command);
}

describe("the artale-overnight renders the judge blocked (#4177)", () => {
	test("the fixture holds the seven System One magick blocks, steps 31 to 37", () => {
		expect(S1_BLOCKED.map((c) => c.step)).toEqual([31, 32, 33, 34, 35, 36, 37]);
	});

	test("each of the seven is allowed by the lane", () => {
		for (const c of S1_BLOCKED) expect(ok(at(c)), `step ${c.step}`).toBe(LANE);
	});

	test("the same seven with a relative output, and with convert, are allowed", () => {
		for (const c of S1_BLOCKED) {
			const rel = at(c).replace(`'${ws}/`, "'");
			expect(ok(rel), `step ${c.step}`).toBe(LANE);
			expect(ok(rel.replace(/^magick /, "convert ")), `step ${c.step}`).toBe(LANE);
		}
	});

	test.skipIf(!existsSync(join(EVIDENCE, "stream.jsonl")) || !LANE)(
		"the verbatim seven, slide text and all, in the real working directory",
		() => {
			const cmds = verbatim();
			expect(cmds.length).toBe(7);
			for (const cmd of cmds) expect(magickRenderInProject(cmd, EVIDENCE_WS, env).ok).toBe(true);
		},
	);

	test("the other magick calls of that run stay with the guards that refused them", () => {
		// Steps 22-29: `D=...; mkdir -p "$D/frames"; magick ...` (a variable and a chain).
		// Step 38: an unbalanced quote the sanitizer refused before System One.
		const others = FIXTURE.calls.filter((c) => c.blockedBy !== "[SYSTEM ONE BLOCKED]");
		expect(others.map((c) => c.step)).toEqual([22, 23, 24, 25, 26, 27, 28, 29, 38]);
		for (const c of others) expect(ok(at(c)), `step ${c.step}`).toBe(false);
	});

	test("before: with the lane off none of the seven takes the allowlist; after: all seven do, judge never asked", async () => {
		const off = { ...env, [SYSTEM_ONE_ALLOWLIST_FLAG]: "0" };
		for (const c of S1_BLOCKED) {
			const r = await systemOneGate(at(c), off, ws);
			expect(r.guard?.backend, `step ${c.step}`).not.toBe("allowlist");
		}
		judge.asks = 0;
		for (const c of S1_BLOCKED) {
			const r = await systemOneGate(at(c), env, ws);
			expect(r.run, `step ${c.step}`).toBe(true);
			if (LANE) {
				expect(r.guard?.backend).toBe("allowlist");
				expect(r.guard?.reason).toContain("magick render from built-in generators");
			}
		}
		if (LANE) expect(judge.asks).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// What the lane allows
// ---------------------------------------------------------------------------

describe("plain renders inside the workspace are allowed", () => {
	const ALLOWED = [
		"magick xc:red out.png",
		"magick -size 64x64 xc:none -fill '#8FD3E8' -draw 'circle 32,32 40,40' .tmp/a.png",
		"convert -size 64x64 gradient:'#000-#fff' sub/new/dir/a.jpg",
		"magick -size 10x10 xc:blue -write .tmp/one.png -flip .tmp/two.webp",
		"magick -size 100x40 -font Didot -pointsize 20 label:'Hello, world' old.png",
		'magick -size 100x40 caption:"Plain text in double quotes" a.gif',
		"magick -size 8x8 pattern:checkerboard plasma: -composite ./a.png",
	];
	for (const cmd of ALLOWED) {
		test(cmd, () => {
			expect(ok(cmd)).toBe(LANE);
		});
	}

	test("an absolute output inside the root", () => {
		expect(ok(`magick xc:red ${ws}/sub/a.png`)).toBe(LANE);
	});
});

// ---------------------------------------------------------------------------
// Escape probes: each one is no opinion, so the judge decides as before
// ---------------------------------------------------------------------------

describe("escape probes go to the judge", () => {
	test("output outside the root: absolute, up a level, through a symlinked folder", () => {
		expect(ok(`magick xc:red ${outside}/x.png`)).toBe(false);
		expect(ok("magick xc:red ../x.png")).toBe(false);
		expect(ok("magick xc:red sub/../../x.png")).toBe(false);
		expect(ok("magick xc:red escape/x.png")).toBe(false);
		expect(ok("magick xc:red /tmp/x.png")).toBe(false);
	});

	test("a dangling symlinked folder the resolver cannot follow", () => {
		symlinkSync(join(outside, "not-yet"), join(ws, "later"));
		expect(ok("magick xc:red later/x.png")).toBe(false);
	});

	test("an output that is a symlink, even a dangling one, or a hardlink to a file outside", () => {
		symlinkSync(join(outside, "new.png"), join(ws, "dangling.png"));
		expect(ok("magick xc:red dangling.png")).toBe(false);
		put("victim.png", "x", outside);
		linkSync(join(outside, "victim.png"), join(ws, "hard.png"));
		expect(ok("magick xc:red hard.png")).toBe(false);
	});

	test("an output that is a folder, a dot folder, or a protected name or place", () => {
		expect(ok("magick xc:red adir.png")).toBe(false);
		expect(ok("magick xc:red .git/x.png")).toBe(false);
		expect(ok("magick xc:red .hidden/x.png")).toBe(false);
		expect(ok("magick xc:red my-secrets.png")).toBe(false);
		expect(ok("magick xc:red hooks/x.png")).toBe(false);
		expect(ok("magick xc:red packages/permissions/x.png")).toBe(false);
	});

	test("an output with a coder prefix, an escape, stdout, or a non-image type", () => {
		for (const o of [
			"msl:out.png",
			"ephemeral:out.png",
			"png:out.png",
			"out%d.png",
			"-",
			"out.sh",
			"out.svg",
			"out.mvg",
			"out.msl",
		])
			expect(ok(`magick xc:red ${o}`), o).toBe(false);
	});

	// Coders that read a file, the network, or a script, or read then delete.
	const CODERS = [
		"msl:x.msl",
		"mvg:x.mvg",
		"svg:x.svg",
		"msvg:x.svg",
		"rsvg:x.svg",
		"url:https://example.com/x.png",
		"https://example.com/x.png",
		"http://example.com/x.png",
		"ftp://example.com/x.png",
		"file:///etc/passwd",
		"ephemeral:old.png",
		"tmp:old.png",
		"text:/etc/passwd",
		"txt:/etc/passwd",
		"inline:data:image/png;base64,AAAA",
		"pango:hello",
		"fd:0",
		"vid:*.png",
		"x:root",
		"screenshot:",
		"clipboard:",
		"print:x",
		"show:x",
		"win:x",
		"ps:x.ps",
		"eps:x.eps",
		"pdf:x.pdf",
		"info:x",
		"mpr:x",
		"old.png",
		"/etc/passwd",
		"magick:logo",
	];
	for (const coder of CODERS) {
		test(`reading ${coder} is no opinion`, () => {
			expect(ok(`magick '${coder}' out.png`)).toBe(false);
		});
	}

	test("every `@` read: label:@, caption:@, text:@, pango:@, an @ list inside or outside the root", () => {
		for (const w of [
			"label:@/etc/passwd",
			"caption:@list.txt",
			"text:@/etc/passwd",
			"pango:@/etc/passwd",
			"@list.txt",
			`@${outside}/list.txt`,
		])
			expect(ok(`magick -size 9x9 ${w} out.png`), w).toBe(false);
		expect(ok("magick -size 9x9 xc:red -annotate +0+0 '@/etc/passwd' out.png")).toBe(false);
		expect(ok("magick -size 9x9 label:'mail me@example.com' out.png")).toBe(false);
	});

	// Options that run a script, read a file, change policy or configuration, or log anywhere.
	const OPTIONS = [
		"-script x.msl",
		"-read x.png",
		"-define registry:temporary-path=/tmp",
		"-set filename:x y",
		"-limit memory 1",
		"-debug all",
		"-log %e",
		"-monitor",
		"-authenticate pw",
		"-tile old.png",
		"-texture old.png",
		"-profile /etc/passwd",
		"-fx u",
		"-format %f",
		"-print %f",
		"-path /tmp",
		"-delegate x",
		"-regard-warnings",
		"-channel-fx red",
	];
	for (const opt of OPTIONS) {
		test(`option ${opt} is no opinion`, () => {
			expect(ok(`magick xc:red ${opt} out.png`)).toBe(false);
		});
	}

	test("-write or +write outside the root, or to a coder", () => {
		expect(ok(`magick xc:red -write ${outside}/x.png out.png`)).toBe(false);
		expect(ok("magick xc:red -write /etc/x.png out.png")).toBe(false);
		expect(ok("magick xc:red +write ../x.png out.png")).toBe(false);
		expect(ok("magick xc:red -write escape/x.png out.png")).toBe(false);
		expect(ok("magick xc:red -write msl:x.png out.png")).toBe(false);
		expect(ok("magick xc:red out.png -write")).toBe(false);
	});

	test("-draw reads nothing: no image primitive, no text, no url fill", () => {
		expect(ok(`magick xc:red -draw "image over 0,0 0,0 '/etc/passwd'" out.png`)).toBe(false);
		expect(ok("magick xc:red -draw 'image over 0,0 0,0 old.png' out.png")).toBe(false);
		expect(ok(`magick xc:red -draw "text 0,0 'x'" out.png`)).toBe(false);
		expect(ok("magick xc:red -draw 'fill url(https://example.com/x)' out.png")).toBe(false);
		expect(ok("magick xc:red -draw 'circle 1,1 2,2 x' out.png")).toBe(false);
	});

	test("arguments must be what their option takes", () => {
		expect(ok("magick xc:red -fill 'url(https://example.com/x)' out.png")).toBe(false);
		expect(ok("magick xc:red -font /etc/passwd out.png")).toBe(false);
		expect(ok("magick xc:red -font ../fonts/x.ttf out.png")).toBe(false);
		expect(ok("magick xc:red -family /etc/passwd out.png")).toBe(false);
		expect(ok("magick -size abc xc:red out.png")).toBe(false);
		expect(ok("magick xc:red -gravity 'x y' out.png")).toBe(false);
		expect(ok("magick xc:red -pointsize big out.png")).toBe(false);
		expect(ok("magick xc:red -modulate 1x1 out.png")).toBe(false);
		expect(ok("magick xc:red -annotate +0+0 '%[fx:1]' out.png")).toBe(false);
		expect(ok("magick xc:red -pointsize out.png")).toBe(false);
	});

	test("generator values must be what the generator takes", () => {
		expect(ok("magick 'xc:url(https://example.com/x)' out.png")).toBe(false);
		expect(ok("magick 'gradient:red-green-blue' out.png")).toBe(false);
		expect(ok("magick 'pattern:../x' out.png")).toBe(false);
		expect(ok("magick 'plasma:../x' out.png")).toBe(false);
		expect(ok("magick label:'%[pixel:p{0,0}]' out.png")).toBe(false);
		expect(ok("magick caption:'100%' out.png")).toBe(false);
	});

	test("the shell sees what the lane sees: no expansion, chaining, redirect, glob, tilde or comment", () => {
		for (const cmd of [
			'magick xc:red "$HOME/x.png"',
			"magick xc:red $HOME/x.png",
			"magick xc:red `pwd`/x.png",
			'magick xc:red "`pwd`/x.png"',
			"magick xc:red ~/x.png",
			"magick xc:red out.png; rm -rf .",
			"magick xc:red out.png && rm -rf .",
			"magick xc:red out.png | sh",
			"magick xc:red out.png > x",
			"magick xc:red *.png",
			"magick xc:red out.png #x.png",
			"magick xc:red out.png &",
			'magick caption:"a\\"b" out.png',
			'magick caption:"hi!" out.png',
			"magick xc:red \\~/x.png",
			"magick 'xc:red out.png",
		])
			expect(ok(cmd), cmd).toBe(false);
	});

	test("a non-ASCII or control character is no opinion", () => {
		expect(ok("magick caption:'caf\u00e9' out.png")).toBe(false);
		expect(ok("magick caption:'a\tb' out.png")).toBe(false);
		expect(ok("magick xc:red out.png\nrm -rf .")).toBe(false);
	});

	test("only magick and convert, with no env prefix and no other tool", () => {
		for (const cmd of [
			"sh xc:red out.png",
			"mogrify -write x.png xc:red",
			"magick mogrify xc:red out.png",
			"magick script x.msl out.png",
			"MAGICK_CONFIGURE_PATH=. magick xc:red out.png",
			"./magick xc:red out.png",
			"magick",
		])
			expect(ok(cmd), cmd).toBe(false);
	});

	test("an in-line variable that resolves outside is no opinion today", () => {
		expect(ok(`D=${outside}; magick xc:red "$D/x.png"`)).toBe(false);
		expect(ok(`D=${outside} magick xc:red "$D/x.png"`)).toBe(false);
	});

	// TODO(#4176): turns on by itself once the boundary resolver reads in-command assignments.
	// Today the unset variable expands to "" and `/x.png` reads as outside.
	const resolverReadsInlineVars = checkCommandBoundary(
		'S1_MAGICK_PROBE_DIR=sub; magick xc:red "$S1_MAGICK_PROBE_DIR/x.png"',
		process.cwd(),
	).allowed;
	test.skipIf(!resolverReadsInlineVars)(
		"after #4176: the resolver itself flags an in-line variable that resolves outside",
		() => {
			const line = `D=${outside}; magick xc:red "$D/x.png"`;
			expect(checkCommandBoundary(line, ws).allowed).toBe(false);
			expect(checkCommandBoundary(`D=${ws}/sub; magick xc:red "$D/x.png"`, ws).allowed).toBe(true);
			expect(ok(line)).toBe(false);
		},
	);
});

// ---------------------------------------------------------------------------
// The magick that runs, and the configuration it reads
// ---------------------------------------------------------------------------

describe("the binary and the configuration are not the workspace's", () => {
	const CMD = "magick xc:red out.png";

	test("a PATH entry inside the workspace, relative, or empty", () => {
		expect(ok(CMD, ws, { ...env, PATH: `${join(ws, "bin")}:${SYSTEM_PATH}` })).toBe(false);
		expect(ok(CMD, ws, { ...env, PATH: `.:${SYSTEM_PATH}` })).toBe(false);
		expect(ok(CMD, ws, { ...env, PATH: `${SYSTEM_PATH}:` })).toBe(false);
	});

	test("MAGICK_* or fontconfig variables in the environment", () => {
		for (const k of [
			"MAGICK_CONFIGURE_PATH",
			"MAGICK_HOME",
			"MAGICK_CODER_MODULE_PATH",
			"MAGICK_TEMPORARY_PATH",
			"FONTCONFIG_FILE",
			"FONTCONFIG_PATH",
		])
			expect(ok(CMD, ws, { ...env, [k]: outside }), k).toBe(false);
	});

	test("ImageMagick's per-user configuration folder resolving into the workspace", () => {
		expect(ok(CMD, ws, { ...env, HOME: ws })).toBe(false);
		const home = join(outside, "home");
		mkdirSync(join(home, ".config"));
		symlinkSync(ws, join(home, ".config", "ImageMagick"));
		expect(ok(CMD)).toBe(false);
		rmSync(join(home, ".config"), { recursive: true });
		// A dangling link to a folder not made yet is followed too.
		symlinkSync(join(ws, "later-cfg"), join(home, ".magick"));
		expect(ok(CMD)).toBe(false);
		rmSync(join(home, ".magick"));
		expect(ok(CMD)).toBe(LANE);
		mkdirSync(join(outside, "xdg"));
		symlinkSync(ws, join(outside, "xdg", "ImageMagick"));
		expect(ok(CMD, ws, { ...env, XDG_CONFIG_HOME: join(outside, "xdg") })).toBe(false);
		expect(ok(CMD, ws, { ...env, XDG_CONFIG_HOME: "rel" })).toBe(false);
	});

	test("an ImageMagick configuration file in the working directory", () => {
		for (const name of ["delegates.xml", "policy.xml", "type.xml", "coder.xml"]) {
			put(name, "<x/>");
			expect(ok(CMD), name).toBe(false);
			rmSync(join(ws, name));
		}
		expect(ok(CMD)).toBe(LANE);
	});

	test("no working directory, or a relative one", () => {
		expect(magickRenderInProject(CMD, undefined, env).ok).toBe(false);
		expect(magickRenderInProject(CMD, "rel", env).ok).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// cd form and root form agree (#3199, #4169)
// ---------------------------------------------------------------------------

describe("after a cd prefix: same answer as the root form, and the project is workspace too", () => {
	const OUTS = [
		"out.png",
		".tmp/a.png",
		"deep/new/a.jpg",
		"escape/x.png",
		".git/x.png",
		"hooks/x.png",
		"adir.png",
		"out.sh",
		"msl:out.png",
	];

	test("parity: cd sub && magick ... P equals magick ... sub/P from the root", () => {
		mkdirSync(join(ws, "sub", "adir.png"));
		symlinkSync(outside, join(ws, "sub", "escape"));
		for (const p of OUTS) {
			const cdForm = ok(`magick xc:red ${p}`, join(ws, "sub"), env, ws);
			const rootForm = ok(
				`magick xc:red ${p.startsWith("msl:") ? `msl:sub/${p.slice(4)}` : `sub/${p}`}`,
			);
			expect(cdForm, p).toBe(rootForm);
		}
		// And the allowed ones really are allowed in both.
		expect(ok("magick xc:red out.png", join(ws, "sub"), env, ws)).toBe(LANE);
		expect(ok("magick xc:red sub/out.png")).toBe(LANE);
	});

	test("parity on the seven evidence renders, relative output", () => {
		mkdirSync(join(ws, "sub", ".tmp", "overnight", "frames"), { recursive: true });
		for (const c of S1_BLOCKED) {
			const cmd = at(c).replace(`'${ws}/`, "'");
			const cdForm = ok(cmd, join(ws, "sub"), env, ws);
			const rootForm = ok(cmd.replace("'.tmp/", "'sub/.tmp/"));
			expect(cdForm, `step ${c.step}`).toBe(LANE);
			expect(rootForm, `step ${c.step}`).toBe(LANE);
		}
	});

	test("the output stays inside the cd folder", () => {
		expect(ok("magick xc:red ../x.png", join(ws, "sub"), env, ws)).toBe(false);
	});

	test("a planted configuration file or PATH entry at the project root counts from the folder", () => {
		const sub = join(ws, "sub");
		put("delegates.xml", "<x/>");
		expect(ok("magick xc:red out.png", sub, env)).toBe(LANE);
		expect(ok("magick xc:red out.png", sub, env, ws)).toBe(false);
		rmSync(join(ws, "delegates.xml"));
		const PATH = `${join(ws, "bin")}:${SYSTEM_PATH}`;
		expect(ok("magick xc:red out.png", sub, { ...env, PATH })).toBe(LANE);
		expect(ok("magick xc:red out.png", sub, { ...env, PATH }, ws)).toBe(false);
	});

	test("a project that does not hold the folder is no opinion", () => {
		const elsewhere = realpathSync.native(tempDir("s1-magick-elsewhere-"));
		expect(ok("magick xc:red out.png", join(ws, "sub"), env, elsewhere)).toBe(false);
		expect(ok("magick xc:red out.png", join(ws, "sub"), env, ws)).toBe(LANE);
	});

	test("systemOneGate passes the project through", async () => {
		const sub = join(ws, "sub");
		put("policy.xml", "<x/>");
		const g = await systemOneGate("magick xc:red out.png", env, sub, undefined, "sub", {
			project: ws,
		});
		expect(g.guard?.backend).not.toBe("allowlist");
		rmSync(join(ws, "policy.xml"));
		const r = await systemOneGate("magick xc:red out.png", env, sub, undefined, "sub", {
			project: ws,
		});
		if (LANE) expect(r.guard?.backend).toBe("allowlist");
	});
});

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

describe("systemOneGate modes", () => {
	const CMD = "magick xc:red out.png";

	test("strict mode (Guarded) never skips the judge", async () => {
		const r = await systemOneGate(CMD, { ...env, [SYSTEM_ONE_FLAG]: "1" }, ws);
		expect(r.run).toBe(false);
		expect(r.guard?.backend).not.toBe("allowlist");
	});

	test("EIGHT_S1_ALLOWLIST=0 turns the lane off with the rest of the allowlist", async () => {
		const r = await systemOneGate(CMD, { ...env, [SYSTEM_ONE_ALLOWLIST_FLAG]: "0" }, ws);
		expect(r.guard?.backend).not.toBe("allowlist");
	});
});

describe("strictWords", () => {
	test("reads quotes and the two escapes as the shell does", () => {
		expect(strictWords("magick \\( xc:'a b' \\) \"c d\" e")).toEqual([
			"magick",
			"(",
			"xc:a b",
			")",
			"c d",
			"e",
		]);
		expect(strictWords("a  'b''c'")).toEqual(["a", "bc"]);
	});
	test("refuses what it does not read exactly", () => {
		for (const s of [
			"a 'b",
			'a "b',
			"a \\x",
			"a ;",
			"a |",
			"a >",
			"a ~",
			"a *",
			"a #",
			'a "b\\c"',
			'a "b!"',
		])
			expect(strictWords(s), s).toBeNull();
	});
});
