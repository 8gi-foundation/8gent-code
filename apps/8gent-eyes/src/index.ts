#!/usr/bin/env bun
/**
 * 8gent-eyes - headless CLI for the eyes capability.
 *
 * Spec: docs/specs/EYES-SPEC.md §6 (headless parity).
 * Issue: #2503.
 *
 * Conventions (per .claude/skills/AgentCLIDesign):
 *   - --json by default (always parseable, never narrative)
 *   - Deterministic exit codes:
 *       0 = ok
 *       1 = backend error (peekaboo crash, AX failure, etc.)
 *       2 = perception:remote tier denied
 *       3 = peekaboo binary missing (or eyes unavailable)
 *       64 = usage error (bad flags, missing args)
 *   - No telemetry beyond the @8gent/audit trace store
 *   - Headless parity: every Eyes method has a CLI form
 *
 * Subcommands:
 *   capture [--display N|all|primary] [--region x,y,w,h]
 *   annotate [--display N|all|primary]
 *   locate --kind {label|role|id|describe|coords} [--text T] [--role R]
 *          [--index I] [--x X] [--y Y]
 *   describe [--prompt P]
 *   wait-for --predicate {element_visible|element_gone|text_present}
 *            [--query-kind ...] [--query-text T] [--query-role R]
 *            [--text T] [--case-sensitive]
 *            [--timeout-ms N] [--poll-ms N]
 *   diff <a.png> <b.png>
 *   observe [--interval-ms N] [--threshold N]   # streams JSONL events
 *   --intent "<natural language>"               # routes to a subcommand
 */

import {
	DEFAULT_FAILOVER,
	type Eyes,
	type CaptureOpts,
	type LocatorQuery,
	type Predicate,
	type PeekabooBackendOpts,
	type VisionProvider,
	selectEyesBackend,
} from "@8gent/eyes";

// ---------------------------------------------------------------------------
// Exit codes
// ---------------------------------------------------------------------------

const EXIT_OK = 0;
const EXIT_BACKEND_ERROR = 1;
const EXIT_PERCEPTION_REMOTE_DENIED = 2;
const EXIT_BACKEND_UNAVAILABLE = 3;
const EXIT_USAGE = 64;

function out(payload: unknown): void {
	process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function fail(exit: number, reason: string, extra: Record<string, unknown> = {}): never {
	process.stdout.write(`${JSON.stringify({ ok: false, exit, reason, ...extra })}\n`);
	process.exit(exit);
}

// ---------------------------------------------------------------------------
// argv parsing (no dep; CLI is small enough that hand-rolled is cheaper)
// ---------------------------------------------------------------------------

interface Argv {
	subcommand: string | null;
	positional: string[];
	flags: Record<string, string | boolean>;
}

function parseArgv(raw: string[]): Argv {
	let subcommand: string | null = null;
	const positional: string[] = [];
	const flags: Record<string, string | boolean> = {};
	let i = 0;
	while (i < raw.length) {
		const a = raw[i] ?? "";
		if (a.startsWith("--")) {
			const key = a.slice(2);
			const eq = key.indexOf("=");
			if (eq >= 0) {
				flags[key.slice(0, eq)] = key.slice(eq + 1);
			} else {
				const next = raw[i + 1];
				if (next !== undefined && !next.startsWith("--")) {
					flags[key] = next;
					i++;
				} else {
					flags[key] = true;
				}
			}
		} else if (subcommand === null) {
			subcommand = a;
		} else {
			positional.push(a);
		}
		i++;
	}
	return { subcommand, positional, flags };
}

function flagStr(argv: Argv, key: string): string | undefined {
	const v = argv.flags[key];
	return typeof v === "string" ? v : undefined;
}
function flagBool(argv: Argv, key: string): boolean {
	return argv.flags[key] === true || argv.flags[key] === "true";
}
function flagNum(argv: Argv, key: string): number | undefined {
	const v = flagStr(argv, key);
	if (v === undefined) return undefined;
	const n = Number(v);
	if (!Number.isFinite(n)) {
		fail(EXIT_USAGE, `flag --${key} must be numeric, got ${JSON.stringify(v)}`);
	}
	return n;
}

function parseDisplayFlag(s?: string): CaptureOpts["displayId"] | undefined {
	if (s === undefined) return undefined;
	if (s === "all" || s === "primary") return s;
	const n = Number(s);
	if (!Number.isFinite(n)) {
		fail(EXIT_USAGE, `--display must be 'all', 'primary', or a numeric index; got ${s}`);
	}
	return n;
}

function parseRegionFlag(s?: string): CaptureOpts["region"] | undefined {
	if (s === undefined) return undefined;
	const parts = s.split(",").map((p) => Number(p.trim()));
	if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
		fail(EXIT_USAGE, `--region must be 'x,y,width,height' with numeric values; got ${s}`);
	}
	return { x: parts[0]!, y: parts[1]!, width: parts[2]!, height: parts[3]! };
}

// ---------------------------------------------------------------------------
// Backend bootstrap
// ---------------------------------------------------------------------------

let _eyes: Eyes | null = null;

async function getEyes(): Promise<Eyes> {
	if (_eyes) return _eyes;
	const backend = await selectEyesBackend([...DEFAULT_FAILOVER]);
	if (!backend) {
		fail(
			EXIT_BACKEND_UNAVAILABLE,
			"no perception backend available. On macOS install: brew install steipete/tap/peekaboo",
		);
	}

	// VisionProvider adapter (post-#2512): shared `eyesVisionProvider` resolves
	// via packages/eight/vision-router and dispatches inference to Ollama or
	// OpenRouter. Two-phase contract lets the eyes backend gate perception:remote
	// BEFORE the model is called (closes #2508).
	const adapter = await import(
		/* @vite-ignore */ "../../../packages/ai/eyes-vision-provider"
	).catch(() => null);
	if (!adapter || typeof adapter.eyesVisionProvider?.describe !== "function") {
		fail(
			EXIT_BACKEND_ERROR,
			"vision adapter not found; CLI must be run from the monorepo (packages/ai/eyes-vision-provider.ts).",
		);
	}
	const visionProvider: VisionProvider = adapter.eyesVisionProvider;

	_eyes = backend.create({
		visionProvider,
		sessionId: process.env.EIGHT_SESSION_ID ?? `cli_${Date.now()}`,
		actor: process.env.EIGHT_ACTOR ?? "cli",
	} as PeekabooBackendOpts);
	return _eyes;
}

// ---------------------------------------------------------------------------
// Subcommand dispatchers
// ---------------------------------------------------------------------------

async function cmdCapture(argv: Argv): Promise<void> {
	const eyes = await getEyes();
	const frame = await eyes.capture({
		displayId: parseDisplayFlag(flagStr(argv, "display")),
		region: parseRegionFlag(flagStr(argv, "region")),
		includeCursor: flagBool(argv, "cursor"),
		format: flagStr(argv, "format") === "jpeg" ? "jpeg" : "png",
	});
	out({ ok: true, frame });
}

async function cmdAnnotate(argv: Argv): Promise<void> {
	const eyes = await getEyes();
	const frame = await eyes.capture({
		displayId: parseDisplayFlag(flagStr(argv, "display")),
	});
	const annotated = await eyes.annotate(frame);
	out({ ok: true, frame, elements: annotated.elements });
}

async function cmdLocate(argv: Argv): Promise<void> {
	const kind = flagStr(argv, "kind");
	let query: LocatorQuery;
	switch (kind) {
		case "label": {
			const text = flagStr(argv, "text");
			if (!text) fail(EXIT_USAGE, "locate --kind=label requires --text");
			query = { kind: "label", text, role: flagStr(argv, "role") };
			break;
		}
		case "role": {
			const role = flagStr(argv, "role");
			if (!role) fail(EXIT_USAGE, "locate --kind=role requires --role");
			query = { kind: "role", role, index: flagNum(argv, "index") };
			break;
		}
		case "id": {
			const id = flagStr(argv, "text");
			if (!id) fail(EXIT_USAGE, "locate --kind=id requires --text (the element id)");
			query = { kind: "id", id };
			break;
		}
		case "describe": {
			const text = flagStr(argv, "text");
			if (!text) fail(EXIT_USAGE, "locate --kind=describe requires --text");
			query = { kind: "describe", text };
			break;
		}
		case "coords": {
			const x = flagNum(argv, "x");
			const y = flagNum(argv, "y");
			if (x === undefined || y === undefined) {
				fail(EXIT_USAGE, "locate --kind=coords requires --x and --y");
			}
			query = { kind: "coords", x, y };
			break;
		}
		default:
			fail(EXIT_USAGE, `locate --kind must be one of label|role|id|describe|coords; got ${kind ?? "(none)"}`);
	}
	const eyes = await getEyes();
	const hits = await eyes.locate(query);
	out({ ok: true, found: hits.length > 0, count: hits.length, locators: hits });
}

async function cmdDescribe(argv: Argv): Promise<void> {
	const eyes = await getEyes();
	const frame = await eyes.capture();
	try {
		const desc = await eyes.describe(frame, flagStr(argv, "prompt"));
		out({ ok: true, frame, description: desc });
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		if (msg.includes("perception:remote")) {
			fail(EXIT_PERCEPTION_REMOTE_DENIED, msg, { frame });
		}
		throw e;
	}
}

async function cmdWaitFor(argv: Argv): Promise<void> {
	const predicateName = flagStr(argv, "predicate");
	let predicate: Predicate;
	if (predicateName === "text_present") {
		const text = flagStr(argv, "text");
		if (!text) fail(EXIT_USAGE, "wait-for --predicate=text_present requires --text");
		predicate = {
			kind: "text_present",
			text,
			caseSensitive: flagBool(argv, "case-sensitive"),
		};
	} else if (predicateName === "element_visible" || predicateName === "element_gone") {
		const qkind = flagStr(argv, "query-kind") ?? "label";
		let q: LocatorQuery;
		if (qkind === "label") {
			const text = flagStr(argv, "query-text");
			if (!text) fail(EXIT_USAGE, "wait-for --query-kind=label requires --query-text");
			q = { kind: "label", text, role: flagStr(argv, "query-role") };
		} else if (qkind === "role") {
			const role = flagStr(argv, "query-role");
			if (!role) fail(EXIT_USAGE, "wait-for --query-kind=role requires --query-role");
			q = { kind: "role", role };
		} else if (qkind === "id") {
			const id = flagStr(argv, "query-text");
			if (!id) fail(EXIT_USAGE, "wait-for --query-kind=id requires --query-text");
			q = { kind: "id", id };
		} else {
			fail(EXIT_USAGE, `wait-for --query-kind must be label|role|id; got ${qkind}`);
		}
		predicate = { kind: predicateName, query: q };
	} else {
		fail(
			EXIT_USAGE,
			`wait-for --predicate must be element_visible|element_gone|text_present; got ${predicateName ?? "(none)"}`,
		);
	}
	const eyes = await getEyes();
	const r = await eyes.wait_for(predicate, {
		timeoutMs: flagNum(argv, "timeout-ms"),
		pollMs: flagNum(argv, "poll-ms"),
	});
	out({ ok: r.ok, elapsedMs: r.elapsedMs, matched: r.matched });
}

async function cmdDiff(argv: Argv): Promise<void> {
	if (argv.positional.length < 2) {
		fail(EXIT_USAGE, "diff requires two positional PNG paths: 8gent-eyes diff <a.png> <b.png>");
	}
	const eyes = await getEyes();
	// Synthesize Frame stubs for the diff helper (only path/width/height/scale are read).
	const a = {
		id: "in_a",
		path: argv.positional[0]!,
		width: 0,
		height: 0,
		displayId: 0,
		capturedAt: 0,
		scale: 1,
		platform: "darwin" as const,
	};
	const b = { ...a, id: "in_b", path: argv.positional[1]! };
	const diff = await eyes.diff(a, b);
	out({ ok: true, diff });
}

async function cmdObserve(argv: Argv): Promise<void> {
	const eyes = await getEyes();
	const intervalMs = flagNum(argv, "interval-ms") ?? 1_000;
	const thresholdSimilarity = flagNum(argv, "threshold");
	const stop = eyes.observe(
		(e) => out({ ok: true, event: { at: e.at, diff: e.diff, frame: e.frame } }),
		{ intervalMs, thresholdSimilarity, region: parseRegionFlag(flagStr(argv, "region")) },
	);
	const sigHandler = () => {
		stop.dispose();
		process.exit(EXIT_OK);
	};
	process.on("SIGINT", sigHandler);
	process.on("SIGTERM", sigHandler);
	await new Promise(() => {}); // run forever until signal
}

// ---------------------------------------------------------------------------
// --intent: route a natural-language phrase to a subcommand
// ---------------------------------------------------------------------------

async function cmdIntent(intent: string, argv: Argv): Promise<void> {
	const t = intent.toLowerCase();
	if (t.startsWith("describe") || t.includes("describe the screen") || t.includes("what is on screen")) {
		argv.flags.prompt = intent.replace(/^describe[: ]?/i, "").trim() || "Describe what is on screen.";
		return cmdDescribe(argv);
	}
	if (t.startsWith("wait") || t.includes("wait until") || t.includes("wait for")) {
		// Intent: "wait until a Save dialog appears" -> text_present "Save"
		const match = intent.match(/(?:wait\s+(?:until|for)\s+)?(?:an?\s+)?(.+?)\s+(?:dialog|button|appears|to appear|shows up)/i);
		argv.flags.predicate = "text_present";
		argv.flags.text = match ? match[1]!.trim() : intent;
		return cmdWaitFor(argv);
	}
	if (t.startsWith("find") || t.startsWith("locate") || t.includes("find the") || t.includes("locate the")) {
		const m = intent.match(/(?:find|locate)(?:\s+the)?\s+(.+?)(?:\s+(?:button|on|in)|$)/i);
		argv.flags.kind = "label";
		argv.flags.text = m ? m[1]!.trim() : intent.replace(/^(find|locate)\s+/i, "").trim();
		return cmdLocate(argv);
	}
	if (t.startsWith("see") || t.includes("what's on") || t.includes("what is on") || t === "see") {
		return cmdAnnotate(argv);
	}
	if (t.startsWith("capture") || t.startsWith("screenshot")) {
		return cmdCapture(argv);
	}
	fail(
		EXIT_USAGE,
		`could not route --intent "${intent}" to a subcommand. Use an explicit subcommand: capture|annotate|locate|describe|wait-for|diff|observe.`,
	);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function printHelp(): Promise<void> {
	out({
		ok: true,
		usage: "8gent-eyes <subcommand> [flags] | 8gent-eyes --intent \"<phrase>\"",
		subcommands: ["capture", "annotate", "locate", "describe", "wait-for", "diff", "observe"],
		spec: "docs/specs/EYES-SPEC.md",
		exit_codes: { ok: 0, backend_error: 1, perception_remote_denied: 2, backend_unavailable: 3, usage: 64 },
	});
}

async function main(): Promise<void> {
	const raw = process.argv.slice(2);
	const argv = parseArgv(raw);

	if (argv.flags.help === true || argv.flags.h === true) return printHelp();

	const intent = flagStr(argv, "intent");
	if (intent) return cmdIntent(intent, argv);

	try {
		switch (argv.subcommand) {
			case "capture":
				return await cmdCapture(argv);
			case "annotate":
				return await cmdAnnotate(argv);
			case "locate":
				return await cmdLocate(argv);
			case "describe":
				return await cmdDescribe(argv);
			case "wait-for":
				return await cmdWaitFor(argv);
			case "diff":
				return await cmdDiff(argv);
			case "observe":
				return await cmdObserve(argv);
			case null:
				return await printHelp();
			default:
				fail(EXIT_USAGE, `unknown subcommand: ${argv.subcommand}`);
		}
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		if (msg.includes("perception:remote")) {
			fail(EXIT_PERCEPTION_REMOTE_DENIED, msg);
		}
		fail(EXIT_BACKEND_ERROR, msg);
	}
}

main();
