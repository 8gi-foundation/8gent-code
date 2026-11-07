/**
 * Stream rules (#72). An optional, local file, <home>/.8gent/stream-rules.json:
 *
 *   [{ "pattern": "regex", "correction": "one line", "max_retries": 1 }]
 *
 * While a reply streams, if the text so far matches a rule, that generation is
 * aborted, the correction is appended as a system note and the step is retried
 * once (at most one retry per turn; the retry is not re-checked). With no file
 * nothing changes: the feature is off by default and nothing is ever installed.
 * Invalid rules are dropped one by one; a broken file means no rules.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveHome } from "../core/home";

type Env = Record<string, string | undefined>;

export interface StreamRule {
	pattern: RegExp;
	correction: string;
}

export function streamRulesPath(env: Env = process.env): string {
	return join(resolveHome(env), ".8gent", "stream-rules.json");
}

/** The valid rules in the file, or null when there is no file or no valid rule. */
export function loadStreamRules(env: Env = process.env): StreamRule[] | null {
	const path = streamRulesPath(env);
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
export function streamGuard(env: Env = process.env): ((text: string) => string | null) | undefined {
	const rules = loadStreamRules(env);
	if (!rules) return undefined;
	return (text) => rules.find((r) => r.pattern.test(text))?.correction ?? null;
}
