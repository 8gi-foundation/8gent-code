/**
 * Blueprints - named, fill-in-the-blanks templates for routines (#3463).
 *
 * A blueprint has typed slots (time, weekdays, enum, text). Filling one
 * validates every slot and returns the exact options object that
 * RoutineManager.create() already accepts, so there is one path to job
 * creation and no second scheduler.
 *
 * Safety: the cron string is built only from validated time, weekday and
 * enum values. Text slots reach the prompt only, never the schedule, and the
 * routine runner passes the prompt to the agent as a single argv element.
 *
 * Trial behind EIGHT_BLUEPRINTS=1. With any other value createFromBlueprint
 * refuses and the one surface, `8gent blueprint` in bin/8gent.ts, writes
 * nothing. Nothing runs routines automatically yet; `8gent blueprint run <id>`
 * runs a saved one once through RoutineManager.trigger().
 */

import type { RoutineManager } from "./routines";

export type RoutineOpts = Parameters<RoutineManager["create"]>[0];

export type Slot =
	| { kind: "time"; key: string; label: string; default?: string }
	| { kind: "weekdays"; key: string; label: string; max?: number; default?: string[] }
	| { kind: "enum"; key: string; label: string; options: string[]; default?: string }
	| {
			kind: "text";
			key: string;
			label: string;
			maxLength: number;
			/** Optional stricter shape, with a hint shown when it fails */
			pattern?: { re: RegExp; hint: string };
			default?: string;
	  };

/** Values a schedule may be built from. Text slots are excluded by type. */
export interface ScheduleParts {
	hour: number;
	minute: number;
	/** cron weekday numbers, 0 = Sunday, sorted and unique */
	days: number[];
	choice: Record<string, string>;
}

export interface Blueprint {
	name: string;
	description: string;
	slots: Slot[];
	schedule: (p: ScheduleParts) => string;
	prompt: (v: Record<string, string>) => string;
}

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri"];

function dayField(days: number[]): string {
	return days.length === 7 ? "*" : days.join(",");
}

export const BLUEPRINTS: Blueprint[] = [
	{
		name: "morning-brief",
		description: "A short brief at a set time on chosen days.",
		slots: [
			{ kind: "time", key: "time", label: "What time?", default: "08:30" },
			{ kind: "weekdays", key: "days", label: "Which days?", default: WEEKDAYS },
			{ kind: "enum", key: "focus", label: "Focus on?", options: ["repos", "issues", "everything"], default: "everything" },
		],
		schedule: (p) => `${p.minute} ${p.hour} * * ${dayField(p.days)}`,
		prompt: (v) => `Write my morning brief. Focus: ${v.focus}. Keep it under 200 words.`,
	},
	{
		name: "pr-watch",
		description: "Check open pull requests on a repo at a fixed interval on chosen days.",
		slots: [
			{
				kind: "text",
				key: "repo",
				label: "Which repo (owner/name)?",
				maxLength: 100,
				pattern: { re: /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, hint: "owner/name, e.g. 8gi-foundation/8gent-code" },
			},
			{ kind: "enum", key: "every", label: "How often?", options: ["1h", "2h", "6h"], default: "2h" },
			{ kind: "weekdays", key: "days", label: "Which days?", default: WEEKDAYS },
		],
		schedule: (p) => {
			const hours = { "1h": "*", "2h": "*/2", "6h": "*/6" }[p.choice.every];
			if (!hours) throw new Error(`pr-watch: no schedule for every=${p.choice.every}`);
			return `0 ${hours} * * ${dayField(p.days)}`;
		},
		prompt: (v) =>
			`List open pull requests on ${v.repo} updated in the last ${{ "1h": "hour", "2h": "2 hours", "6h": "6 hours" }[v.every]} and say which need review.`,
	},
	{
		name: "weekly-review",
		description: "A weekly review of what shipped and what is stuck.",
		slots: [
			{ kind: "weekdays", key: "day", label: "Which day?", max: 1, default: ["fri"] },
			{ kind: "time", key: "time", label: "What time?", default: "16:00" },
			{ kind: "text", key: "notes", label: "Anything to include?", maxLength: 200, default: "nothing extra" },
		],
		schedule: (p) => `${p.minute} ${p.hour} * * ${dayField(p.days)}`,
		prompt: (v) => `Run my weekly review: what shipped, what is stuck, what is next. Also: ${v.notes}.`,
	},
];

export function blueprintsEnabled(): boolean {
	return process.env.EIGHT_BLUEPRINTS === "1";
}

export function getBlueprint(name: string): Blueprint | undefined {
	return BLUEPRINTS.find((b) => b.name === name);
}

export class BlueprintError extends Error {}

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
// Letters (any script), marks, digits, spaces and basic punctuation only.
// Control characters, newlines, backtick, dollar, ; | & < > are refused.
const TEXT_RE = /^[\p{L}\p{M}\p{N} .,:!?'"()\/_@#+=-]+$/u;
const CRON_RE = /^[0-9*,/]+( [0-9*,/]+){4}$/;

/**
 * Validate slot values and build the RoutineManager.create() options.
 * Pure: touches no file and schedules nothing. Throws BlueprintError with a
 * message naming the slot on any bad value.
 */
export function fillBlueprint(name: string, input: Record<string, unknown>): RoutineOpts {
	const bp = getBlueprint(name);
	if (!bp) throw new BlueprintError(`Unknown blueprint "${name}". Known: ${BLUEPRINTS.map((b) => b.name).join(", ")}`);
	const known = new Set(bp.slots.map((s) => s.key));
	for (const k of Object.keys(input)) {
		if (!known.has(k)) throw new BlueprintError(`${name}: unknown slot "${k}"`);
	}

	const values: Record<string, string> = {};
	const parts: ScheduleParts = { hour: 0, minute: 0, days: [0, 1, 2, 3, 4, 5, 6], choice: {} };
	for (const slot of bp.slots) {
		const raw = input[slot.key] ?? slot.default;
		const bad = (why: string) => new BlueprintError(`${name}: slot "${slot.key}" ${why}`);
		if (raw === undefined) throw bad("is required");
		if (slot.kind === "time") {
			const m = typeof raw === "string" ? TIME_RE.exec(raw) : null;
			if (!m) throw bad(`must be HH:MM in 24-hour time, got ${JSON.stringify(raw)}`);
			parts.hour = Number(m[1]);
			parts.minute = Number(m[2]);
			values[slot.key] = raw as string;
		} else if (slot.kind === "weekdays") {
			const list = typeof raw === "string" ? raw.split(",") : raw;
			if (!Array.isArray(list) || list.length === 0) throw bad("must list at least one day (mon..sun)");
			const nums = list.map((d) => DAYS.indexOf(String(d).trim().toLowerCase()));
			if (nums.includes(-1)) throw bad(`days must be from ${DAYS.join(",")}, got ${JSON.stringify(raw)}`);
			parts.days = [...new Set(nums)].sort((a, b) => a - b);
			if (slot.max && parts.days.length > slot.max) throw bad(`takes at most ${slot.max} day(s), got ${parts.days.length}`);
			values[slot.key] = parts.days.map((n) => DAYS[n]).join(",");
		} else if (slot.kind === "enum") {
			if (typeof raw !== "string" || !slot.options.includes(raw)) {
				throw bad(`must be one of ${slot.options.join(", ")}, got ${JSON.stringify(raw)}`);
			}
			parts.choice[slot.key] = raw;
			values[slot.key] = raw;
		} else {
			if (typeof raw !== "string") throw bad("must be text");
			const text = raw.trim();
			if (text.length === 0) throw bad("must not be empty");
			if (text.length > slot.maxLength) throw bad(`must be at most ${slot.maxLength} characters`);
			if (text.startsWith("-")) throw bad("must not start with '-'");
			if (!TEXT_RE.test(text)) throw bad("may only use letters, digits, spaces and basic punctuation");
			if (slot.pattern && !slot.pattern.re.test(text)) throw bad(`must look like ${slot.pattern.hint}`);
			values[slot.key] = text;
		}
	}

	const schedule = bp.schedule(parts);
	if (!CRON_RE.test(schedule)) throw new BlueprintError(`${name}: built an invalid schedule "${schedule}"`);
	return { name: bp.name, description: bp.description, schedule, prompt: bp.prompt(values) };
}

/** The only creation path: flag check, validate, then RoutineManager.create(). */
export function createFromBlueprint(mgr: RoutineManager, name: string, input: Record<string, unknown>) {
	if (!blueprintsEnabled()) throw new BlueprintError("Blueprints are off. Set EIGHT_BLUEPRINTS=1 to try them.");
	return mgr.create(fillBlueprint(name, input));
}
