#!/usr/bin/env bun
/**
 * bench-voice-decide - measure the NeuDecide audio router on OUR clips (#3688).
 *
 * The authors report 46 ms time-to-call on an M3 and their own SLURP accuracy.
 * This checks latency and accuracy on this machine with our own command set.
 * Nothing here is a number until it has been run against the real weights.
 *
 * Clips: a directory of WAVs named `<intent>__<anything>.wav`, where <intent>
 * is one of VOICE_DECIDE_CANDIDATES or `none` (dictation that must NOT route).
 *
 *   bun scripts/bench-voice-decide.ts --synth             # make clips with macOS `say`
 *   bun scripts/bench-voice-decide.ts --backend mock      # plumbing check, not a measurement
 *   bun scripts/bench-voice-decide.ts --backend neudecide # the real run (weights required)
 *
 * Flags: --clips <dir> (default $TMPDIR/voice-decide-clips), --out <file.json>,
 * --min-confidence <0..1>, --timeout-ms <n> (default 30000; first call loads the model).
 *
 * Latency is end to end through our runner: one Python process per call, so
 * it includes interpreter start and model load. It is our number for our
 * integration, not a like-for-like check of the authors' 46 ms.
 */

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AudioDecideBackend,
	DEFAULT_MIN_CONFIDENCE,
	MockAudioBackend,
	NeuDecideBackend,
	VOICE_DECIDE_CANDIDATES,
	routeVoiceAudio,
} from "../packages/decide/backends/neudecide";

const args = process.argv.slice(2);
const flag = (name: string, fallback?: string) => {
	const i = args.indexOf(`--${name}`);
	return i >= 0 ? args[i + 1] : fallback;
};

const clipsDir = flag(
	"clips",
	join(process.env.TMPDIR || tmpdir(), "voice-decide-clips"),
) as string;
const backendName = flag("backend", "mock") as string;
const minConfidence = Number(flag("min-confidence", String(DEFAULT_MIN_CONFIDENCE)));
const timeoutMs = Number(flag("timeout-ms", "30000"));

/** Two spoken phrasings per intent, plus dictation that should fall back. */
const PHRASES: Record<string, string[]> = {
	submit: ["send it", "submit that"],
	scratch: ["scratch that", "clear the input"],
	undo_word: ["delete the last word", "undo that word"],
	newline: ["new line", "start a new line"],
	help: ["what can I say", "help"],
	repeat: ["say that again", "repeat that"],
	cancel: ["never mind", "cancel"],
	none: [
		"add a retry to the fetch helper in the network module",
		"rename the config loader to read settings",
	],
};

if (args.includes("--synth")) {
	mkdirSync(clipsDir, { recursive: true });
	let n = 0;
	for (const [intent, phrases] of Object.entries(PHRASES)) {
		for (const [i, phrase] of phrases.entries()) {
			const out = join(clipsDir, `${intent}__synth${i}.wav`);
			const p = Bun.spawnSync(["say", "-o", out, "--data-format=LEI16@16000", phrase]);
			if (p.exitCode !== 0) {
				console.error(`say failed for "${phrase}": ${p.stderr.toString().trim()}`);
				process.exit(1);
			}
			n++;
		}
	}
	console.log(`wrote ${n} synthetic clips to ${clipsDir} (macOS say voice, not a human)`);
	process.exit(0);
}

const files = readdirSync(clipsDir)
	.filter((f) => f.endsWith(".wav") && f.includes("__"))
	.sort();
if (files.length === 0) {
	console.error(`no <intent>__*.wav clips in ${clipsDir}; run with --synth or record your own`);
	process.exit(1);
}

const names = VOICE_DECIDE_CANDIDATES.map((c) => c.name);
const labelOf = (f: string) => f.split("__")[0];

function backendFor(label: string): AudioDecideBackend {
	if (backendName === "neudecide") return new NeuDecideBackend();
	if (backendName === "mock") {
		// Oracle mock: always right. Exercises the plumbing; its numbers mean nothing.
		return new MockAudioBackend(() =>
			label === "none" ? null : names.map((n) => (n === label ? 1 : 0)),
		);
	}
	console.error(`unknown --backend ${backendName} (mock | neudecide)`);
	process.exit(1);
}

interface Row {
	clip: string;
	expected: string;
	got: string;
	confidence: number | null;
	ms: number;
	detail?: string;
}

const rows: Row[] = [];
for (const f of files) {
	const expected = labelOf(f);
	const audio = new Uint8Array(readFileSync(join(clipsDir, f)));
	const t0 = performance.now();
	const r = await routeVoiceAudio(backendFor(expected), audio, VOICE_DECIDE_CANDIDATES, {
		minConfidence,
		timeoutMs,
	});
	const ms = performance.now() - t0;
	rows.push({
		clip: f,
		expected,
		got: r.routed ? r.choice : `fallback:${r.reason}`,
		confidence: r.routed ? r.confidence : null,
		ms: Math.round(ms),
		detail: r.routed ? undefined : r.detail,
	});
}

const commands = rows.filter((r) => r.expected !== "none");
const dictation = rows.filter((r) => r.expected === "none");
const correct = commands.filter((r) => r.got === r.expected).length;
// The dangerous failure: routed confidently to the wrong intent.
const wrongRoutes = rows.filter(
	(r) => !r.got.startsWith("fallback:") && r.got !== r.expected,
).length;
const errors = rows.filter((r) => r.got === "fallback:error").length;
const lat = rows.map((r) => r.ms).sort((a, b) => a - b);
const pct = (p: number) => lat[Math.min(lat.length - 1, Math.floor((p / 100) * lat.length))];

const summary = {
	backend: backendName,
	measurement:
		backendName === "mock"
			? "MOCK plumbing check, not a measurement of NeuDecide"
			: "measured on this machine",
	date: new Date().toISOString(),
	clips: rows.length,
	commandExactMatch: commands.length ? correct / commands.length : null,
	dictationFallbackRate: dictation.length
		? dictation.filter((r) => r.got.startsWith("fallback:")).length / dictation.length
		: null,
	wrongRoutes,
	errors,
	latencyMs: { first: rows[0]?.ms, p50: pct(50), p95: pct(95), max: lat[lat.length - 1] },
	minConfidence,
	rows,
};

console.log(JSON.stringify({ ...summary, rows: undefined }, null, 2));
if (errors === rows.length) {
	console.error(
		`every clip errored; first error: ${rows[0]?.detail ?? "unknown"}. Are the weights fetched?`,
	);
}
const out = flag("out");
if (out) {
	writeFileSync(out, `${JSON.stringify(summary, null, 2)}\n`);
	console.log(`wrote ${out}`);
}
