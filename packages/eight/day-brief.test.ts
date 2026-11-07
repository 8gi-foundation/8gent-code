import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CONNECT_LINE,
	COUNT_BUDGET,
	MAX_EVENTS,
	dayBrief,
	eventsOn,
	fetchCalendar,
	isDayQuestion,
	parseIcs,
	parseIcsDate,
	readCalendarFile,
	runCalendarCommand,
	tasksFor,
} from "./day-brief";

const ics = (...events: string[]) =>
	["BEGIN:VCALENDAR", "VERSION:2.0", ...events, "END:VCALENDAR"].join("\r\n");
const vevent = (...props: string[]) => ["BEGIN:VEVENT", ...props, "END:VEVENT"].join("\r\n");

// Saturday 7 November 2026, mid-morning local time.
const SAT = new Date(2026, 10, 7, 10, 30);

function home(): string {
	return mkdtempSync(join(tmpdir(), "day-brief-"));
}

describe("isDayQuestion", () => {
	for (const q of [
		"how does my day look today?",
		"How does my day look like today",
		"How's my day looking?",
		"what's on today",
		"What's on my calendar today?",
		"whats on my calendar",
		"what do I have today",
		"my schedule today",
		"hey 8gent, how does my day look today?",
		"show me my day",
		"how's today looking",
	]) {
		test(`yes: ${q}`, () => expect(isDayQuestion(q)).toBe(true));
	}
	for (const q of [
		"how does my day look in the code",
		"fix the calendar parser today",
		"what is the schedule module",
		"hi",
		"",
	]) {
		test(`no: ${JSON.stringify(q)}`, () => expect(isDayQuestion(q)).toBe(false));
	}
});

describe("parseIcsDate", () => {
	test("all-day, wall clock and UTC", () => {
		expect(parseIcsDate("20261107")).toEqual({ date: new Date(2026, 10, 7), allDay: true });
		expect(parseIcsDate("20261107T093000", { TZID: "Europe/Dublin" })?.date).toEqual(
			new Date(2026, 10, 7, 9, 30),
		);
		expect(parseIcsDate("20261107T093000Z")?.date.toISOString()).toBe("2026-11-07T09:30:00.000Z");
		expect(parseIcsDate("garbage")).toBeNull();
	});
});

describe("eventsOn: what happens today", () => {
	test("single, all-day, folded lines, escaped text, and other days left out", () => {
		const text = ics(
			vevent("UID:a", "SUMMARY:Standup", "DTSTART:20261107T090000", "DTEND:20261107T093000"),
			vevent(
				"UID:b",
				"SUMMARY:Dublin\\, family day",
				"DTSTART;VALUE=DATE:20261107",
				"DTEND;VALUE=DATE:20261108",
			),
			vevent("UID:c", "SUMMARY:Long", " er title", "DTSTART:20261107T140000", "LOCATION:Room 1"),
			vevent("UID:d", "SUMMARY:Tomorrow", "DTSTART:20261108T090000"),
			vevent("UID:e", "SUMMARY:Cancelled", "STATUS:CANCELLED", "DTSTART:20261107T110000"),
		);
		const items = eventsOn(parseIcs(text), SAT);
		expect(items.map((i) => i.summary)).toEqual(["Dublin, family day", "Standup", "Longer title"]);
		expect(items[1]).toMatchObject({ startMin: 540, endMin: 570 });
		expect(items[2]?.location).toBe("Room 1");
	});

	test("a VALARM inside an event does not end it", () => {
		const text = ics(
			[
				"BEGIN:VEVENT",
				"SUMMARY:Gym",
				"DTSTART:20261107T070000",
				"BEGIN:VALARM",
				"TRIGGER:-PT10M",
				"END:VALARM",
				"END:VEVENT",
			].join("\r\n"),
		);
		expect(eventsOn(parseIcs(text), SAT).map((i) => i.summary)).toEqual(["Gym"]);
	});

	test("weekly by day, with an interval, an exception and a moved instance", () => {
		const weekly = vevent(
			"UID:w",
			"SUMMARY:Team sync",
			"DTSTART:20261003T100000", // a Saturday
			"DTEND:20261003T110000",
			"RRULE:FREQ=WEEKLY;BYDAY=SA",
		);
		expect(eventsOn(parseIcs(ics(weekly)), SAT).map((i) => [i.summary, i.startMin])).toEqual([
			["Team sync", 600],
		]);
		const fortnightly = weekly.replace("FREQ=WEEKLY", "FREQ=WEEKLY;INTERVAL=2");
		// 3 Oct + 5 weeks = 7 Nov: odd week, so not on a fortnightly rule.
		expect(eventsOn(parseIcs(ics(fortnightly)), SAT)).toEqual([]);
		const skipped = weekly.replace("END:VEVENT", "EXDATE:20261107T100000\r\nEND:VEVENT");
		expect(eventsOn(parseIcs(ics(skipped)), SAT)).toEqual([]);
		const moved = vevent(
			"UID:w",
			"SUMMARY:Team sync (moved)",
			"RECURRENCE-ID:20261107T100000",
			"DTSTART:20261107T150000",
		);
		expect(eventsOn(parseIcs(ics(weekly, moved)), SAT).map((i) => i.summary)).toEqual([
			"Team sync (moved)",
		]);
	});

	test("UNTIL and COUNT end a series", () => {
		const daily = (extra: string) =>
			ics(vevent("UID:d", "SUMMARY:Pills", "DTSTART:20261101T080000", `RRULE:FREQ=DAILY;${extra}`));
		expect(eventsOn(parseIcs(daily("UNTIL=20261106T235959Z")), SAT)).toEqual([]);
		expect(eventsOn(parseIcs(daily("COUNT=6")), SAT)).toEqual([]); // 1..6 Nov
		expect(eventsOn(parseIcs(daily("COUNT=7")), SAT)).toHaveLength(1); // 1..7 Nov
	});

	test("monthly on the first Saturday, and on a month day; yearly birthday", () => {
		const first = ics(
			vevent("UID:m", "SUMMARY:Market", "DTSTART:20260704T090000", "RRULE:FREQ=MONTHLY;BYDAY=1SA"),
		);
		expect(eventsOn(parseIcs(first), SAT)).toHaveLength(1);
		const last = ics(
			vevent("UID:m", "SUMMARY:Market", "DTSTART:20260704T090000", "RRULE:FREQ=MONTHLY;BYDAY=-1SA"),
		);
		expect(eventsOn(parseIcs(last), SAT)).toHaveLength(0);
		const byDay = ics(
			vevent(
				"UID:r",
				"SUMMARY:Rent",
				"DTSTART;VALUE=DATE:20260107",
				"RRULE:FREQ=MONTHLY;BYMONTHDAY=7",
			),
		);
		expect(eventsOn(parseIcs(byDay), SAT)).toHaveLength(1);
		const bday = ics(
			vevent("UID:y", "SUMMARY:Birthday", "DTSTART;VALUE=DATE:19901107", "RRULE:FREQ=YEARLY"),
		);
		expect(eventsOn(parseIcs(bday), SAT).map((i) => i.allDay)).toEqual([true]);
	});

	test("a series that starts later is not shown early", () => {
		const text = ics(
			vevent("UID:l", "SUMMARY:Later", "DTSTART:20261201T090000", "RRULE:FREQ=DAILY"),
		);
		expect(eventsOn(parseIcs(text), SAT)).toEqual([]);
	});
});

describe("tasksFor", () => {
	test("overdue and due today first, then in progress; done and later tasks left out", () => {
		const json = JSON.stringify({
			tasks: [
				{ subject: "Later", status: "pending", dueDate: "2026-11-20T09:00:00" },
				{ subject: "Doing", status: "in_progress" },
				{ subject: "Today", status: "pending", priority: "high", dueDate: "2026-11-07T17:00:00" },
				{ subject: "Late", status: "blocked", dueDate: "2026-11-01T09:00:00" },
				{ subject: "Done", status: "completed", dueDate: "2026-11-07T09:00:00" },
			],
		});
		expect(tasksFor(json, SAT).map((t) => [t.subject, t.due ?? t.status])).toEqual([
			["Today", "due today"],
			["Late", "overdue"],
			["Doing", "in_progress"],
		]);
	});

	test("a broken file is no tasks, never a crash", () => {
		expect(tasksFor("{nope", SAT)).toEqual([]);
	});
});

describe("dayBrief", () => {
	test("nothing connected: says so and gives the one command", async () => {
		const h = home();
		const text = await dayBrief({ home: h, env: {}, now: SAT });
		expect(text).toContain("Today, Saturday 7 November.");
		expect(text).toContain("No calendar connected");
		expect(text).toContain(CONNECT_LINE);
		expect(text).toContain("No open tasks due today.");
	});

	test("a connected file and tasks: the day, read on the device", async () => {
		const h = home();
		mkdirSync(join(h, ".8gent"), { recursive: true });
		const cal = join(h, "cal.ics");
		writeFileSync(
			cal,
			ics(vevent("UID:a", "SUMMARY:Standup", "DTSTART:20261107T090000", "DTEND:20261107T093000")),
		);
		writeFileSync(
			join(h, ".8gent", "tasks.json"),
			JSON.stringify({ tasks: [{ subject: "Ship it", status: "pending", dueDate: "2026-11-07" }] }),
		);
		expect((await runCalendarCommand(["connect", cal], { home: h, env: {} })).code).toBe(0);
		const text = await dayBrief({ home: h, env: {}, now: SAT });
		expect(text).toContain("  09:00-09:30  Standup");
		expect(text).toContain("  - Ship it (due today)");
		expect(text).toContain("nothing left it");
	});

	test("a link is fetched from its own host and never printed", async () => {
		const h = home();
		const link = "https://calendar.example.com/private-abc123secret/basic.ics";
		await runCalendarCommand(["connect", link], { home: h, env: {} });
		const asked: string[] = [];
		const text = await dayBrief({
			home: h,
			env: {},
			now: SAT,
			fetchText: async (u) => {
				asked.push(u);
				return ics(vevent("UID:x", "SUMMARY:Lunch", "DTSTART:20261107T130000"));
			},
		});
		expect(asked).toEqual([link]);
		expect(text).toContain("13:00");
		expect(text).toContain("Calendar fetched from calendar.example.com");
		expect(text).not.toContain("abc123secret");
	});

	test("a link that fails says why in one line, and the tasks still show", async () => {
		const h = home();
		await runCalendarCommand(["connect", "https://cal.example.com/x.ics"], { home: h, env: {} });
		const text = await dayBrief({
			home: h,
			env: {},
			now: SAT,
			fetchText: async () => {
				throw new Error("HTTP 404");
			},
		});
		expect(text).toContain("Could not read your calendar from cal.example.com: HTTP 404.");
		expect(text).toContain("No open tasks due today.");
	});
});

describe("8gent calendar", () => {
	test("connect writes only the config, private to the user; off removes it", async () => {
		const h = home();
		const r = await runCalendarCommand(["connect", "webcal://cal.example.com/a.ics"], {
			home: h,
			env: {},
		});
		expect(r.code).toBe(0);
		expect(r.text).toContain("cal.example.com");
		const path = join(h, ".8gent", "calendar.json");
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
			calendar: "https://cal.example.com/a.ics",
		});
		expect(statSync(path).mode & 0o077).toBe(0);
		expect((await runCalendarCommand(["off"], { home: h, env: {} })).code).toBe(0);
		expect(existsSync(path)).toBe(false);
	});

	test("a plain http link and a missing file are refused", async () => {
		const h = home();
		expect(
			(await runCalendarCommand(["connect", "http://x.example/a.ics"], { home: h, env: {} })).code,
		).toBe(2);
		expect(
			(await runCalendarCommand(["connect", join(h, "nope.ics")], { home: h, env: {} })).code,
		).toBe(2);
		expect(existsSync(join(h, ".8gent", "calendar.json"))).toBe(false);
	});

	test("no words prints the day; anything else prints usage", async () => {
		const h = home();
		expect((await runCalendarCommand([], { home: h, env: {}, now: SAT })).text).toContain("Today,");
		expect((await runCalendarCommand(["what"], { home: h, env: {} })).code).toBe(2);
	});
});

describe("8SO hardening (#50 review)", () => {
	const ok = (body: string) => new Response(body, { status: 200 });
	const redirect = (to: string) => new Response(null, { status: 302, headers: { location: to } });

	test("a same-host https redirect is followed; another host or plain http is refused", async () => {
		const seen: string[] = [];
		const fake = (to: string) => async (u: string, init: RequestInit) => {
			expect(init.redirect).toBe("manual");
			seen.push(u);
			return seen.length === 1 ? redirect(to) : ok("BEGIN:VCALENDAR");
		};
		expect(await fetchCalendar("https://cal.example.com/a.ics", fake("/b.ics"))).toBe(
			"BEGIN:VCALENDAR",
		);
		expect(seen).toEqual(["https://cal.example.com/a.ics", "https://cal.example.com/b.ics"]);
		for (const to of ["https://evil.example.net/x", "http://cal.example.com/b.ics"]) {
			seen.length = 0;
			await expect(fetchCalendar("https://cal.example.com/a.ics", fake(to))).rejects.toThrow(
				"redirected elsewhere",
			);
			expect(seen).toHaveLength(1);
		}
	});

	test("more than three redirects are refused", async () => {
		let n = 0;
		const loop = async () => redirect(`/hop${++n}`);
		await expect(fetchCalendar("https://cal.example.com/a.ics", loop)).rejects.toThrow("too many");
		expect(n).toBe(4);
	});

	test("a 60 MB body is abandoned early, while streaming", async () => {
		let pulled = 0;
		const chunk = new Uint8Array(1 << 20); // 1 MB
		const body = new ReadableStream<Uint8Array>({
			pull(c) {
				if (pulled >= 60) return c.close();
				pulled++;
				c.enqueue(chunk);
			},
		});
		await expect(
			fetchCalendar("https://cal.example.com/a.ics", async () => new Response(body)),
		).rejects.toThrow("larger than 5 MB");
		expect(pulled).toBeLessThanOrEqual(8);
	});

	test("a Content-Length over 5 MB is refused before reading", async () => {
		let pulled = 0;
		const body = new ReadableStream<Uint8Array>({
			pull(c) {
				pulled++;
				c.enqueue(new Uint8Array(10));
			},
		});
		const res = new Response(body, { headers: { "content-length": String(60_000_000) } });
		await expect(fetchCalendar("https://cal.example.com/a.ics", async () => res)).rejects.toThrow(
			"larger than 5 MB",
		);
		expect(pulled).toBeLessThanOrEqual(1);
	});

	test("20,000 COUNT series answer in under 1 s, capped, and the answer says so", async () => {
		const h = home();
		mkdirSync(join(h, ".8gent"), { recursive: true });
		const evs: string[] = [];
		for (let i = 0; i < 20_000; i++) {
			evs.push(
				vevent(
					`UID:c${i}`,
					`SUMMARY:S${i}`,
					"DTSTART:20170101T090000",
					"RRULE:FREQ=WEEKLY;BYDAY=MO,SA;COUNT=9999",
				),
			);
		}
		const cal = join(h, "big.ics");
		writeFileSync(cal, ics(...evs));
		await runCalendarCommand(["connect", cal], { home: h, env: {} });
		const t0 = performance.now();
		const text = await dayBrief({ home: h, env: {}, now: SAT });
		const ms = performance.now() - t0;
		expect(ms).toBeLessThan(1000);
		expect(text).toContain(`more than ${MAX_EVENTS.toLocaleString("en")} events`);
		expect(text).toContain("too many repeats to check");
		expect(COUNT_BUDGET).toBeGreaterThan(0);
	});

	test("simple daily and weekly COUNT series need no walk and stay exact", () => {
		const weekly = (count: number) =>
			parseIcs(
				ics(
					vevent(
						"UID:w",
						"SUMMARY:W",
						"DTSTART:20261003T100000",
						`RRULE:FREQ=WEEKLY;COUNT=${count}`,
					),
				),
			);
		// 3 Oct is occurrence 1; 7 Nov is occurrence 6.
		expect(eventsOn(weekly(6), SAT)).toHaveLength(1);
		expect(eventsOn(weekly(5), SAT)).toHaveLength(0);
	});

	test("an existing 644 calendar.json becomes 600 on connect", async () => {
		const h = home();
		mkdirSync(join(h, ".8gent"), { recursive: true });
		const path = join(h, ".8gent", "calendar.json");
		writeFileSync(path, "{}");
		chmodSync(path, 0o644);
		await runCalendarCommand(["connect", "https://cal.example.com/a.ics"], { home: h, env: {} });
		expect(statSync(path).mode & 0o777).toBe(0o600);
	});

	test("a FIFO or an oversized file is refused, never read", () => {
		const h = home();
		const fifo = join(h, "pipe.ics");
		expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
		expect(() => readCalendarFile(fifo)).toThrow("not a regular file");
		const big = join(h, "big.ics");
		writeFileSync(big, "x".repeat(100));
		expect(() => readCalendarFile(big, 50)).toThrow("larger than 5 MB");
	});

	test("connect with no link reads it from the hidden prompt", async () => {
		const h = home();
		const prompts: string[] = [];
		const r = await runCalendarCommand(["connect"], {
			home: h,
			env: {},
			readHidden: async (p) => {
				prompts.push(p);
				return "https://cal.example.com/private-xyz/basic.ics";
			},
		});
		expect(prompts[0]).toContain("hidden");
		expect(r.code).toBe(0);
		expect(r.text).not.toContain("private-xyz");
		const empty = await runCalendarCommand(["connect"], {
			home: h,
			env: {},
			readHidden: async () => "",
		});
		expect(empty.code).toBe(2);
	});
});
