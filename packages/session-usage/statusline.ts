/**
 * Reader for a harness whose status line passes JSON on stdin.
 *
 *   <harness status line command> | bun packages/session-usage/statusline.ts \
 *     --harness <name> --account <label> [--session <name>]
 *
 * Reads stdin, writes one record, prints one short line. No model call, no
 * network. Every number is optional: what the harness did not send is null.
 */

import * as path from "node:path";
import { type SessionUsageRecord, writeRecord } from "./index";

const num = (v: unknown): number | null =>
	typeof v === "number" && Number.isFinite(v) ? v : null;
const str = (v: unknown): string | null =>
	typeof v === "string" && v.length > 0 ? v : null;

/** Highest used percentage across any reported limit windows, else null. */
function limitPct(limits: unknown): number | null {
	if (!limits || typeof limits !== "object") return null;
	const vals = Object.values(limits as Record<string, any>)
		.map((w) => num(w?.used_percentage))
		.filter((v): v is number => v !== null);
	return vals.length ? Math.max(...vals) : null;
}

export function recordFromStatusJson(
	input: any,
	opts: { harness?: string; account?: string; session?: string; now?: Date },
): SessionUsageRecord | null {
	if (!input || typeof input !== "object") return null;
	const session = opts.session ?? str(input.session_id);
	if (!session) return null;
	const cw = input.context_window ?? {};
	const window = num(cw.context_window_size);
	let used = num(cw.total_input_tokens);
	const usedPct = num(cw.used_percentage);
	if (used === null && usedPct !== null && window !== null) {
		used = Math.round((usedPct / 100) * window);
	}
	const dir = str(input.workspace?.project_dir) ?? str(input.workspace?.current_dir) ?? str(input.cwd);
	return {
		version: 1,
		session,
		workspace: dir ? path.basename(dir) : null,
		harness: opts.harness ?? null,
		account: opts.account ?? null,
		contextUsed: used,
		contextWindow: window,
		usagePct: limitPct(input.rate_limits),
		updatedAt: (opts.now ?? new Date()).toISOString(),
	};
}

function flag(name: string): string | undefined {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 ? process.argv[i + 1] : undefined;
}

if (import.meta.main) {
	const raw = await Bun.stdin.text();
	try {
		const rec = recordFromStatusJson(JSON.parse(raw), {
			harness: flag("harness"),
			account: flag("account") ?? process.env.EIGHT_ACCOUNT_LABEL,
			session: flag("session"),
		});
		if (rec) {
			writeRecord(rec);
			console.log(rec.session);
		}
	} catch {
		// A status line must never break the session it sits in.
	}
}
