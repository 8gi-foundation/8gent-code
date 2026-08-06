/**
 * Per-officer EXECUTION harness resolution + disclosure.
 *
 * `resolveHarness` is the single place that decides which CLI Helm spawns for
 * an officer's approved proposal: the coded default in officers.ts, optionally
 * overridden by a human-edited config file. See officers.ts's file-level "CHAT
 * vs EXECUTION" note - this module is about EXECUTION only, never the officer's
 * chat backend.
 *
 * Config-file-first, read-only from the UI's perspective: James edits
 * ~/.8gent/table-harness.json directly (the same directory as
 * helm-worker.env / relay-pairing-secret - already the established location
 * for this class of local, non-repo config). No new daemon<->UI write path,
 * no second source of truth.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OFFICERS, type HarnessKind, type OfficerHarness } from "./officers";

/** Resolved fresh on every read (not cached at module scope) so a test - or a
 *  real HOME change - is honoured without a process restart. TABLE_HARNESS_CONFIG
 *  is a test-only escape hatch (same pattern as helm-bridge.ts's PAIRING_SECRET
 *  env override for `bearer()`) - Bun's os.homedir() does not track a
 *  runtime-reassigned $HOME, so tests need a direct path override rather than
 *  writing into the real, machine-wide ~/.8gent/table-harness.json. */
function configPath(): string {
	const override = process.env.TABLE_HARNESS_CONFIG;
	if (override?.trim()) return override.trim();
	return path.join(os.homedir(), ".8gent", "table-harness.json");
}

// goose intentionally absent - see officers.ts's HarnessKind doc comment. A
// value of "goose" in the config file is therefore treated as unknown/invalid
// and falls back to the officer's coded default (with a logged warning), the
// same as any other unrecognised string.
const VALID_KINDS = new Set<HarnessKind>([
	"claude",
	"codex",
	"8gent-local",
	"shell",
	"pi",
	"cursor-agent",
	"opencode",
]);

/** Harness kinds that can incur a paid API call per approved proposal. */
export const CLOUD_BILLED_KINDS: ReadonlySet<HarnessKind> = new Set<HarnessKind>([
	"claude",
	"codex",
	"cursor-agent",
]);

/**
 * Read + parse the config file fresh (no caching = the hot-reload behaviour:
 * edit the file, the very next resolveHarness() call for that officer sees
 * it, no daemon restart). Returns null on a missing file or malformed JSON -
 * both are silently "no override", never a crash.
 */
function readConfig(): Record<string, Partial<OfficerHarness> & { kind?: unknown }> | null {
	let raw: unknown;
	try {
		raw = JSON.parse(fs.readFileSync(configPath(), "utf8"));
	} catch {
		return null; // no file, or unreadable/malformed JSON: coded default for everyone
	}
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	return raw as Record<string, Partial<OfficerHarness> & { kind?: unknown }>;
}

/**
 * Resolve officerCode's ACTIVE harness: file override if present and valid,
 * else the coded default from officers.ts. Reads the file FRESH on every
 * call - this IS the hot-reload behaviour, no caching, no daemon restart
 * needed. A malformed file, an unknown officer code, or an unknown/invalid
 * kind name is logged and IGNORED (falls back to the coded default) - this
 * function never throws and never crashes the daemon.
 *
 * Returns undefined only for an officer code that officers.ts itself does not
 * know (there is no coded default to fall back to) - the caller (helm-bridge's
 * bindOfficerHarness) treats that as "leave whatever was already there alone".
 */
export function resolveHarness(officerCode: string): OfficerHarness | undefined {
	const fallback = OFFICERS[officerCode]?.harness;
	const raw = readConfig();
	if (!raw) return fallback;
	const entry = raw[officerCode];
	if (!entry || typeof entry !== "object") return fallback;
	if (!entry.kind || typeof entry.kind !== "string" || !VALID_KINDS.has(entry.kind as HarnessKind)) {
		if (entry.kind !== undefined) {
			console.warn(
				`[table-harness] ${officerCode}: unknown/unavailable kind ${JSON.stringify(entry.kind)}, falling back to ${fallback?.kind ?? "(no coded default)"}`,
			);
		}
		return fallback;
	}
	return {
		kind: entry.kind as HarnessKind,
		model: typeof entry.model === "string" ? entry.model : undefined,
		skills: Array.isArray(entry.skills) ? entry.skills.filter((s): s is string => typeof s === "string") : undefined,
	};
}

/**
 * Startup disclosure only (never a gate): one WARN per officer bound to a
 * cloud-billed CLI, so James is choosing knowingly. No cost figure invented -
 * per this repo's "no dollar values" rule, this names WHICH officers can
 * incur API cost, never an estimate of how much.
 */
export function logCloudBilledOfficers(): void {
	for (const officer of Object.values(OFFICERS)) {
		const h = resolveHarness(officer.code);
		if (h && CLOUD_BILLED_KINDS.has(h.kind)) {
			console.warn(
				`[table-harness] ${officer.code} (${officer.name}) harness=${h.kind} is cloud-billed; every approved proposal may call a paid API.`,
			);
		}
	}
}
