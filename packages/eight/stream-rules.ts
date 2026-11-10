/**
 * Stream rules (#72). An optional, local file, <data dir>/stream-rules.json:
 *
 *   [{ "pattern": "regex", "correction": "one line", "max_retries": 1 }]
 *
 * While a reply streams, if the tail of the text so far matches a rule, that
 * generation is aborted, the correction is appended as a system note and the
 * step is retried once (at most one retry per turn; the retry is not
 * re-checked). With no file nothing changes: the feature is off by default and
 * nothing is ever installed. Invalid rules are dropped one by one; a broken
 * file means no rules.
 *
 * The file puts a system-role message into future turns, so it is protected
 * like hooks.yaml and yolo.json: it is in PROTECTED_DATA_FILES, and its path is
 * picked from protectedDataRoots(), so wherever it is read from, run_command
 * cannot write it.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, normalize } from "node:path";
import { protectedDataRoots, trustedSecurityValue } from "../permissions/run-command-sandbox";
import { resolveHome } from "../core/home";

export const STREAM_RULES_FILE = "stream-rules.json";

export interface StreamRule {
	pattern: RegExp;
	correction: string;
}

/**
 * The data dir the rules are read from: EIGHT_DATA_DIR, else EIGHT_HOME's
 * .8gent, else ~/.8gent, each from the load-time security snapshot (a .env
 * cannot move it) and only if it is one of the roots the sandbox protects.
 */
export function streamRulesRoot(): string {
	const roots = protectedDataRoots();
	const dataDir = trustedSecurityValue("EIGHT_DATA_DIR");
	const eightHome = trustedSecurityValue("EIGHT_HOME");
	const candidates = [
		dataDir,
		eightHome ? join(resolveHome({ EIGHT_HOME: eightHome }), ".8gent") : undefined,
	];
	for (const c of candidates) {
		if (c && roots.includes(normalize(c))) return normalize(c);
	}
	return roots[0];
}

export function streamRulesPath(root: string = streamRulesRoot()): string {
	return join(root, STREAM_RULES_FILE);
}

/**
 * A group that holds a quantifier and is itself quantified, like (a+)+ or
 * (?:x*y)*: the shape that backtracks exponentially. A bounded window does not
 * save a pattern like that, so the rule is dropped.
 */
export function nestedQuantifier(source: string): boolean {
	return /\((?:[^()\\]|\\.)*[+*}](?:[^()\\]|\\.)*\)[+*{]/.test(source);
}

/** The valid rules in the file, or null when there is no file or no valid rule. */
export function loadStreamRules(root?: string): StreamRule[] | null {
	const path = streamRulesPath(root);
	if (!existsSync(path)) return null;
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
	if (!Array.isArray(raw)) return null;
	const rules: StreamRule[] = [];
	for (const r of raw as Array<Record<string, unknown>>) {
		if (typeof r?.pattern !== "string" || r.pattern === "") continue;
		if (typeof r.correction !== "string") continue;
		const correction = r.correction.trim();
		if (correction === "" || /[\r\n]/.test(correction)) continue;
		if (r.max_retries !== 1) continue;
		if (nestedQuantifier(r.pattern)) continue;
		try {
			rules.push({ pattern: new RegExp(r.pattern), correction });
		} catch {
			// a bad regex drops this rule only
		}
	}
	return rules.length > 0 ? rules : null;
}

/**
 * The guard buildTextToolCall takes: text so far in, the correction of the
 * first matching rule out (null for no match). Undefined when there are no rules.
 */
export function streamGuard(root?: string): ((text: string) => string | null) | undefined {
	const rules = loadStreamRules(root);
	if (!rules) return undefined;
	return (text) => rules.find((r) => r.pattern.test(text))?.correction ?? null;
}
