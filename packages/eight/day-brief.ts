/**
 * "How does my day look today?" answered on the device, by code, at zero tokens.
 *
 * Asked on a phone, this used to go to whatever model was picked, which had no
 * calendar and no tasks to read, and when that model's key was rejected the
 * person got an error instead of a day. Now a day question is answered here,
 * from two local sources and nothing else:
 *
 *  - a calendar the person connected (`8gent calendar connect <file or https link>`):
 *    an .ics file on the device, or an https iCal link (Google, iCloud, Outlook and
 *    most CalDAV servers publish one). Off until connected. A link is fetched from
 *    its own host only, and the link itself is never printed (it is a secret).
 *  - the local task store, ~/.8gent/tasks.json: open tasks due today or earlier,
 *    and tasks in progress.
 *
 * With no calendar connected the answer says so and gives the one command.
 * No dependency: the iCal reader below covers single events, all-day events,
 * UTC and wall-clock times, and DAILY/WEEKLY/MONTHLY/YEARLY repeats with
 * INTERVAL, BYDAY (MONTHLY may say "1MO" or "-1FR"), BYMONTHDAY, UNTIL, COUNT,
 * EXDATE and moved instances (RECURRENCE-ID). A TZID time is read as the
 * device's own wall clock. Not done: the CalDAV REPORT protocol (an https iCal
 * link covers the same calendars) and other repeat rules (those events are skipped).
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { resolveHome } from "../core/home.js";

// ── Which messages are a day question ────────────────────────────────────────

const DAY_QUESTIONS = [
	/^(?:how does|hows|how is|whats|what is|what does) my (?:day|schedule|calendar|agenda)(?: today)?(?: look(?:ing)?(?: like)?)?(?: (?:for )?today)?$/,
	/^(?:hows|how is) (?:my )?today(?: looking)?$/,
	/^what(?:s| is) on(?: my (?:calendar|schedule|agenda))?(?: for)? today$/,
	/^whats on my (?:calendar|schedule|agenda)$/,
	/^what do i have(?: on)? today$/,
	/^(?:my )?(?:day|schedule|agenda|calendar)(?: for)? today$/,
	/^(?:show|give|tell) me my (?:day|schedule|agenda|calendar)(?: (?:for )?today)?$/,
];

function flatten(text: string): string {
	return text
		.toLowerCase()
		.replace(/^\[mode: [^\]]*\]\s*/, "")
		.replace(/['’]/g, "")
		.replace(/[^a-z0-9 ]+/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/^(?:hey|hi|ok|okay|so) /, "")
		.replace(/^(?:8gent|eight) /, "");
}

/** True when the whole message asks what today holds, and nothing else. */
export function isDayQuestion(text: string): boolean {
	const flat = flatten(text);
	return flat.length > 0 && flat.length <= 60 && DAY_QUESTIONS.some((re) => re.test(flat));
}

// ── The iCal reader ─────────────────────────────────────────────────────────

export interface CalendarEvent {
	uid?: string;
	summary: string;
	location?: string;
	start: Date;
	end?: Date;
	allDay: boolean;
	rrule?: Record<string, string>;
	/** Local yyyymmdd keys of skipped repeats. */
	exdates: string[];
	/** Local yyyymmdd of the repeat this event replaces. */
	recurrenceId?: string;
	cancelled: boolean;
}

interface Prop {
	name: string;
	params: Record<string, string>;
	value: string;
}

function parseLine(line: string): Prop | null {
	let quoted = false;
	let colon = -1;
	for (let i = 0; i < line.length; i++) {
		const c = line[i];
		if (c === '"') quoted = !quoted;
		else if (c === ":" && !quoted) {
			colon = i;
			break;
		}
	}
	if (colon < 0) return null;
	const [name = "", ...rawParams] = line.slice(0, colon).split(";");
	const params: Record<string, string> = {};
	for (const p of rawParams) {
		const eq = p.indexOf("=");
		if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, "");
	}
	return { name: name.toUpperCase(), params, value: line.slice(colon + 1) };
}

function unescapeText(v: string): string {
	return v.replace(/\\([\\;,nN])/g, (_, c: string) => (c === "n" || c === "N" ? " " : c)).trim();
}

/** An iCal date or date-time: all-day, UTC (Z), or wall clock (floating or TZID). */
export function parseIcsDate(
	value: string,
	params: Record<string, string> = {},
): { date: Date; allDay: boolean } | null {
	const v = value.trim();
	const d = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
	if (d || params.VALUE === "DATE") {
		const m = d ?? /^(\d{4})(\d{2})(\d{2})/.exec(v);
		if (!m) return null;
		return { date: new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])), allDay: true };
	}
	const t = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/.exec(v);
	if (!t) return null;
	const [y, mo, da, h, mi, s] = [t[1], t[2], t[3], t[4], t[5], t[6] ?? "0"].map(Number) as number[];
	const date = t[7]
		? new Date(Date.UTC(y as number, (mo as number) - 1, da, h, mi, s))
		: new Date(y as number, (mo as number) - 1, da, h, mi, s);
	return { date, allDay: false };
}

export function dayKey(d: Date): string {
	return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

/** Every VEVENT in an iCal text. Unparseable events are skipped, never fatal. */
export function parseIcs(text: string): CalendarEvent[] {
	const lines = text.replace(/\r?\n[ \t]/g, "").split(/\r?\n/);
	const out: CalendarEvent[] = [];
	let cur: Partial<CalendarEvent> | null = null;
	let depth = 0; // nested blocks inside a VEVENT (VALARM) are ignored
	for (const line of lines) {
		if (line === "BEGIN:VEVENT") {
			cur = { exdates: [], allDay: false, cancelled: false, summary: "" };
			depth = 0;
			continue;
		}
		if (!cur) continue;
		if (line.startsWith("BEGIN:")) {
			depth++;
			continue;
		}
		if (line.startsWith("END:") && depth > 0) {
			depth--;
			continue;
		}
		if (line === "END:VEVENT") {
			if (cur.start) out.push(cur as CalendarEvent);
			cur = null;
			continue;
		}
		if (depth > 0) continue;
		const p = parseLine(line);
		if (!p) continue;
		switch (p.name) {
			case "SUMMARY":
				cur.summary = unescapeText(p.value);
				break;
			case "LOCATION":
				cur.location = unescapeText(p.value) || undefined;
				break;
			case "UID":
				cur.uid = p.value.trim();
				break;
			case "STATUS":
				cur.cancelled = p.value.trim().toUpperCase() === "CANCELLED";
				break;
			case "DTSTART": {
				const r = parseIcsDate(p.value, p.params);
				if (r) {
					cur.start = r.date;
					cur.allDay = r.allDay;
				}
				break;
			}
			case "DTEND": {
				const r = parseIcsDate(p.value, p.params);
				if (r) cur.end = r.date;
				break;
			}
			case "RRULE": {
				const rule: Record<string, string> = {};
				for (const part of p.value.split(";")) {
					const [k, v] = part.split("=");
					if (k && v) rule[k.toUpperCase()] = v.toUpperCase();
				}
				cur.rrule = rule;
				break;
			}
			case "EXDATE":
				for (const v of p.value.split(",")) {
					const r = parseIcsDate(v, p.params);
					if (r) cur.exdates?.push(dayKey(r.date));
				}
				break;
			case "RECURRENCE-ID": {
				const r = parseIcsDate(p.value, p.params);
				if (r) cur.recurrenceId = dayKey(r.date);
				break;
			}
		}
	}
	return out;
}

// ── Does an event happen on a given day ─────────────────────────────────────

const WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
const DAY_MS = 86_400_000;

function midnight(d: Date): Date {
	return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function daysBetween(a: Date, b: Date): number {
	return Math.round((midnight(b).getTime() - midnight(a).getTime()) / DAY_MS);
}

function mondayOf(d: Date): Date {
	const m = midnight(d);
	return new Date(m.getFullYear(), m.getMonth(), m.getDate() - ((m.getDay() + 6) % 7));
}

/** The rule's pattern alone (no COUNT, no UNTIL): does `day` fit it? */
function fitsPattern(rule: Record<string, string>, start: Date, day: Date): boolean {
	const interval = Math.max(1, Number(rule.INTERVAL) || 1);
	const byday = rule.BYDAY ? rule.BYDAY.split(",") : [];
	const wd = WEEKDAYS[day.getDay()] as string;
	switch (rule.FREQ) {
		case "DAILY":
			if (byday.length > 0 && !byday.includes(wd)) return false;
			return daysBetween(start, day) % interval === 0;
		case "WEEKLY": {
			const days = byday.length > 0 ? byday : [WEEKDAYS[start.getDay()] as string];
			if (!days.includes(wd)) return false;
			const weeks = Math.round(daysBetween(mondayOf(start), mondayOf(day)) / 7);
			return weeks % interval === 0;
		}
		case "MONTHLY": {
			const months =
				(day.getFullYear() - start.getFullYear()) * 12 + day.getMonth() - start.getMonth();
			if (months % interval !== 0) return false;
			if (rule.BYMONTHDAY) return rule.BYMONTHDAY.split(",").map(Number).includes(day.getDate());
			if (byday.length > 0) {
				return byday.some((b) => {
					const m = /^(-?\d)?([A-Z]{2})$/.exec(b);
					if (!m || m[2] !== wd) return false;
					if (!m[1]) return true;
					const n = Number(m[1]);
					const nth = Math.floor((day.getDate() - 1) / 7) + 1;
					const daysInMonth = new Date(day.getFullYear(), day.getMonth() + 1, 0).getDate();
					const fromEnd = -(Math.floor((daysInMonth - day.getDate()) / 7) + 1);
					return n > 0 ? nth === n : fromEnd === n;
				});
			}
			return day.getDate() === start.getDate();
		}
		case "YEARLY": {
			if ((day.getFullYear() - start.getFullYear()) % interval !== 0) return false;
			const month = rule.BYMONTH ? Number(rule.BYMONTH) - 1 : start.getMonth();
			return day.getMonth() === month && day.getDate() === start.getDate();
		}
		default:
			return false;
	}
}

/** Longest a COUNT is walked, in days: ten years. */
const COUNT_WALK_DAYS = 3660;

export function occursOn(
	ev: CalendarEvent,
	day: Date,
	movedKeys: ReadonlySet<string> = new Set(),
): boolean {
	if (ev.cancelled) return false;
	const dayStart = midnight(day);
	const dayEnd = new Date(dayStart.getFullYear(), dayStart.getMonth(), dayStart.getDate() + 1);
	if (!ev.rrule) {
		const end = ev.end ?? (ev.allDay ? new Date(ev.start.getTime() + DAY_MS) : ev.start);
		if (end.getTime() === ev.start.getTime()) return ev.start >= dayStart && ev.start < dayEnd;
		return ev.start < dayEnd && end > dayStart;
	}
	const key = dayKey(dayStart);
	if (ev.exdates.includes(key)) return false;
	if (ev.uid && movedKeys.has(`${ev.uid}|${key}`)) return false;
	if (dayStart < midnight(ev.start)) return false;
	const until = ev.rrule.UNTIL ? parseIcsDate(ev.rrule.UNTIL) : null;
	if (until && dayStart > midnight(until.date)) return false;
	if (!fitsPattern(ev.rrule, ev.start, dayStart)) return false;
	const count = Number(ev.rrule.COUNT);
	if (count > 0) {
		let seen = 0;
		const first = midnight(ev.start);
		const span = Math.min(daysBetween(first, dayStart), COUNT_WALK_DAYS);
		for (let i = 0; i <= span; i++) {
			const d = new Date(first.getFullYear(), first.getMonth(), first.getDate() + i);
			if (fitsPattern(ev.rrule, ev.start, d)) seen++;
			if (seen > count) return false;
		}
	}
	return true;
}

export interface DayItem {
	summary: string;
	location?: string;
	allDay: boolean;
	/** Minutes after local midnight, for timed items. */
	startMin?: number;
	endMin?: number;
}

/** What happens on `day`, all-day items first, then by start time. */
export function eventsOn(events: CalendarEvent[], day: Date): DayItem[] {
	const moved = new Set(
		events.filter((e) => e.uid && e.recurrenceId).map((e) => `${e.uid}|${e.recurrenceId}`),
	);
	const items: DayItem[] = [];
	for (const ev of events) {
		if (!occursOn(ev, day, moved)) continue;
		const item: DayItem = { summary: ev.summary || "(no title)", allDay: ev.allDay };
		if (ev.location) item.location = ev.location;
		if (!ev.allDay) {
			const dayStart = midnight(day).getTime();
			// A repeat keeps the first event's time of day; a single event keeps its own,
			// clipped to today when it started yesterday.
			const s = ev.rrule
				? ev.start.getHours() * 60 + ev.start.getMinutes()
				: Math.max(0, Math.round((ev.start.getTime() - dayStart) / 60_000));
			item.startMin = s;
			if (ev.end && ev.end > ev.start) {
				const e = ev.rrule
					? s + Math.round((ev.end.getTime() - ev.start.getTime()) / 60_000)
					: Math.round((ev.end.getTime() - dayStart) / 60_000);
				item.endMin = Math.min(24 * 60, e);
			}
		}
		items.push(item);
	}
	return items.sort((a, b) => {
		if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
		return (a.startMin ?? 0) - (b.startMin ?? 0) || a.summary.localeCompare(b.summary);
	});
}

// ── Local tasks ─────────────────────────────────────────────────────────────

export interface DayTask {
	subject: string;
	status: string;
	priority?: string;
	due?: string;
}

/** Open tasks due by the end of `day`, then tasks in progress, from tasks.json text. */
export function tasksFor(json: string, day: Date): DayTask[] {
	let store: { tasks?: Array<Record<string, unknown>> };
	try {
		store = JSON.parse(json);
	} catch {
		return [];
	}
	const end = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1).getTime();
	const open = new Set(["pending", "in_progress", "blocked"]);
	const due: DayTask[] = [];
	const doing: DayTask[] = [];
	for (const t of store.tasks ?? []) {
		const status = String(t.status ?? "");
		if (!open.has(status)) continue;
		const task: DayTask = { subject: String(t.subject ?? "").trim() || "(untitled task)", status };
		if (typeof t.priority === "string") task.priority = t.priority;
		const dueAt = typeof t.dueDate === "string" ? Date.parse(t.dueDate) : Number.NaN;
		if (!Number.isNaN(dueAt) && dueAt < end) {
			task.due = dueAt < midnight(day).getTime() ? "overdue" : "due today";
			due.push(task);
		} else if (status === "in_progress") doing.push(task);
	}
	return [...due, ...doing];
}

// ── Where the calendar comes from ───────────────────────────────────────────

export interface DayDeps {
	home?: string;
	env?: Record<string, string | undefined>;
	now?: Date;
	fetchText?: (url: string) => Promise<string>;
}

const MAX_CALENDAR_BYTES = 5_000_000;
const FETCH_TIMEOUT_MS = 10_000;

function eightDir(deps: DayDeps): string {
	return join(deps.home ?? resolveHome(), ".8gent");
}

export function calendarConfigPath(deps: DayDeps = {}): string {
	return join(eightDir(deps), "calendar.json");
}

/** The connected calendar (a file path or an https link), or null: off by default. */
export function connectedCalendar(deps: DayDeps = {}): string | null {
	const env = deps.env ?? process.env;
	if (env.EIGHT_CALENDAR?.trim()) return env.EIGHT_CALENDAR.trim();
	try {
		const c = JSON.parse(readFileSync(calendarConfigPath(deps), "utf8")) as { calendar?: unknown };
		return typeof c.calendar === "string" && c.calendar.trim() ? c.calendar.trim() : null;
	} catch {
		return null;
	}
}

function isLink(source: string): boolean {
	return /^https:\/\//i.test(source);
}

function hostOf(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return "the link";
	}
}

function expandPath(p: string, home: string): string {
	const x = p.startsWith("~/") ? join(home, p.slice(2)) : p;
	return isAbsolute(x) ? x : resolve(x);
}

async function defaultFetchText(url: string): Promise<string> {
	const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	const text = await res.text();
	if (text.length > MAX_CALENDAR_BYTES) throw new Error("calendar is larger than 5 MB");
	return text;
}

// ── The answer ──────────────────────────────────────────────────────────────

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH_NAMES = [
	"January",
	"February",
	"March",
	"April",
	"May",
	"June",
	"July",
	"August",
	"September",
	"October",
	"November",
	"December",
];

function hhmm(min: number): string {
	return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}

export const CONNECT_LINE =
	"To connect one (it stays off until you do): 8gent calendar connect <file.ics or https iCal link>";

/** The day, in plain lines. Never throws: a source that fails says why in one line. */
export async function dayBrief(deps: DayDeps = {}): Promise<string> {
	const now = deps.now ?? new Date();
	const home = deps.home ?? resolveHome();
	const heading = `Today, ${DAY_NAMES[now.getDay()]} ${now.getDate()} ${MONTH_NAMES[now.getMonth()]}.`;
	const lines: string[] = [heading];

	const source = connectedCalendar({ ...deps, home });
	let calendarNote: string;
	if (!source) {
		lines.push("No calendar connected, so I can only see your tasks.", CONNECT_LINE);
		calendarNote = "";
	} else {
		let text: string | null = null;
		try {
			text = isLink(source)
				? await (deps.fetchText ?? defaultFetchText)(source)
				: readFileSync(expandPath(source, home), "utf8");
		} catch (e) {
			const why = e instanceof Error ? e.message : String(e);
			const where = isLink(source) ? hostOf(source) : expandPath(source, home);
			lines.push(
				`Could not read your calendar from ${where}: ${why.split("\n")[0]?.slice(0, 80)}.`,
			);
		}
		if (text !== null) {
			const items = eventsOn(parseIcs(text), now);
			if (items.length === 0) lines.push("Nothing on your calendar today.");
			for (const it of items) {
				const when = it.allDay
					? "all day    "
					: `${hhmm(it.startMin ?? 0)}${it.endMin !== undefined ? `-${hhmm(it.endMin)}` : "      "}`;
				lines.push(`  ${when}  ${it.summary}${it.location ? ` (${it.location})` : ""}`);
			}
		}
		calendarNote = isLink(source)
			? `Calendar fetched from ${hostOf(source)}; nothing else left this device.`
			: "Read from files on this device; nothing left it.";
	}

	let tasks: DayTask[] = [];
	const tasksPath = join(home, ".8gent", "tasks.json");
	if (existsSync(tasksPath)) {
		try {
			tasks = tasksFor(readFileSync(tasksPath, "utf8"), now);
		} catch {
			tasks = [];
		}
	}
	if (tasks.length > 0) {
		lines.push("Tasks:");
		for (const t of tasks.slice(0, 5)) {
			const tag = t.due ?? (t.status === "in_progress" ? "in progress" : t.status);
			lines.push(
				`  - ${t.subject} (${tag}${t.priority && t.priority !== "medium" ? `, ${t.priority}` : ""})`,
			);
		}
		if (tasks.length > 5) lines.push(`  and ${tasks.length - 5} more: /task to see them`);
	} else {
		lines.push("No open tasks due today.");
	}
	if (calendarNote) lines.push(calendarNote);
	return lines.join("\n");
}

// ── `8gent calendar` ────────────────────────────────────────────────────────

export const CALENDAR_USAGE = [
	"Usage:",
	"  8gent calendar                         today's calendar and tasks",
	"  8gent calendar connect <file.ics>      read an iCal file on this device",
	"  8gent calendar connect <https link>    read a private iCal link (Google: Settings, your",
	"                                         calendar, Secret address in iCal format)",
	"  8gent calendar off                     disconnect",
].join("\n");

/** `8gent calendar [connect <source> | off]`. Writes only ~/.8gent/calendar.json. */
export async function runCalendarCommand(
	args: string[],
	deps: DayDeps = {},
): Promise<{ code: number; text: string }> {
	const home = deps.home ?? resolveHome();
	const sub = (args[0] ?? "").toLowerCase();
	const path = calendarConfigPath({ ...deps, home });
	if (sub === "" || sub === "today") {
		return { code: 0, text: await dayBrief({ ...deps, home }) };
	}
	if (sub === "off" || sub === "disconnect") {
		rmSync(path, { force: true });
		return { code: 0, text: "Calendar disconnected." };
	}
	if (sub === "connect" && args[1]) {
		const raw = args[1].trim();
		let stored: string;
		let shown: string;
		if (/^http:\/\//i.test(raw)) {
			return {
				code: 2,
				text: "Use the https link: a plain http link would send your calendar in clear.",
			};
		}
		if (/^webcal:\/\//i.test(raw) || isLink(raw)) {
			stored = raw.replace(/^webcal:\/\//i, "https://");
			shown = hostOf(stored);
		} else {
			stored = expandPath(raw, home);
			if (!existsSync(stored)) return { code: 2, text: `No file at ${stored}.` };
			shown = stored;
		}
		mkdirSync(join(home, ".8gent"), { recursive: true });
		writeFileSync(path, `${JSON.stringify({ calendar: stored }, null, 2)}\n`, { mode: 0o600 });
		return {
			code: 0,
			text: `Calendar connected: ${shown}. Ask "how does my day look today?" in 8gent, or run 8gent calendar.`,
		};
	}
	return { code: 2, text: CALENDAR_USAGE };
}
