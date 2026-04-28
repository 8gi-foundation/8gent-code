/**
 * Shared helpers for the BDH data pipeline.
 *
 * Sanitisation, JSONL IO, CLI arg parsing, and provenance helpers used by
 * every script in this directory. Sealed to PII / secret stripping; do not
 * grow this into a junk drawer.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { TrainingExample } from "../types.ts";

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// Phone regex - tightened to avoid matching ISO 8601 timestamps. Old loose
// pattern \+?\d[\d\s().-]{8,}\d matched "2026-04-28T07:46" because the
// digit-hyphen-digit alternation matches the date format. Restricted to
// real phone-number shapes only:
//   - E.164:        +1 555-123-4567 / +44 20 7946 0958
//   - NANP parens:  (555) 123-4567
//   - Strict 3-3-4: 555-123-4567 (with consistent . or - separators)
const PHONE_RE = /(?:\+\d{1,3}[\s.-]?\d{2,4}[\s.-]?\d{3,4}[\s.-]?\d{0,4})|(?:\(\d{3}\)\s*\d{3}[\s.-]?\d{4})|(?:\b\d{3}[.-]\d{3}[.-]\d{4}\b)/g;
const CREDIT_CARD_RE = /\b(?:\d[ -]?){13,19}\b/g;
const OPENAI_KEY_RE = /sk-[a-zA-Z0-9]{20,}/g;
const GITHUB_PAT_RE = /ghp_[a-zA-Z0-9]{20,}/g;
const XAI_KEY_RE = /xai-[a-zA-Z0-9]{20,}/g;

const REDACTED = "[REDACTED]";

function scrubString(s: string): string {
	return s
		.replace(OPENAI_KEY_RE, REDACTED)
		.replace(GITHUB_PAT_RE, REDACTED)
		.replace(XAI_KEY_RE, REDACTED)
		.replace(EMAIL_RE, REDACTED)
		.replace(PHONE_RE, REDACTED)
		.replace(CREDIT_CARD_RE, REDACTED);
}

function deepSanitise(value: unknown): unknown {
	if (typeof value === "string") return scrubString(value);
	if (Array.isArray(value)) return value.map(deepSanitise);
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			out[k] = deepSanitise(v);
		}
		return out;
	}
	return value;
}

/**
 * Strip PII and secrets from every string field of a TrainingExample.
 * The regex hygiene here is hygiene, not evaluation: the AI Judging Rule
 * applies to deciding *whether an example is good*, not to scrubbing it.
 */
export function sanitiseExample(ex: TrainingExample): TrainingExample {
	return deepSanitise(ex) as TrainingExample;
}

export function readJsonl(p: string): TrainingExample[] {
	if (!fs.existsSync(p)) return [];
	const raw = fs.readFileSync(p, "utf8");
	const lines = raw.split("\n").filter((l) => l.trim().length > 0);
	return lines.map((l) => JSON.parse(l) as TrainingExample);
}

export function writeJsonl(p: string, rows: TrainingExample[]): void {
	fs.mkdirSync(path.dirname(path.resolve(p)), { recursive: true });
	const body = rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length > 0 ? "\n" : "");
	fs.writeFileSync(p, body, "utf8");
}

export function parseArgs(argv: string[]): Record<string, string | boolean> {
	const out: Record<string, string | boolean> = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (!a.startsWith("--")) continue;
		const key = a.slice(2);
		const next = argv[i + 1];
		if (next === undefined || next.startsWith("--")) {
			out[key] = true;
		} else {
			out[key] = next;
			i++;
		}
	}
	return out;
}

export function expandHome(p: string): string {
	if (p.startsWith("~")) return path.join(process.env.HOME || "", p.slice(1));
	return p;
}

export function nowIso(): string {
	return new Date().toISOString();
}

export function isLive(): boolean {
	return process.env.BDH_LIVE === "1";
}

export function exitHelp(text: string): never {
	process.stdout.write(text.trim() + "\n");
	process.exit(0);
}

export function deterministicId(prefix: string, seed: number, idx: number): string {
	return `${prefix}-${seed}-${String(idx).padStart(6, "0")}`;
}
