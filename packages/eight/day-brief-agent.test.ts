/**
 * #48, through the real Agent: "how does my day look today?" is answered from the
 * connected calendar with no model call, and any other message still reaches the model.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dayKey } from "./day-brief";

describe("agent wiring: a day question is answered on the device", () => {
	let Agent: typeof import("./agent").Agent;
	const saved: Record<string, string | undefined> = {};
	let home = "";
	let repo = "";
	let server: ReturnType<typeof Bun.serve>;
	let posts = 0;
	let bodies: string[] = [];

	beforeAll(async () => {
		home = mkdtempSync(join(tmpdir(), "day-agent-home-"));
		repo = mkdtempSync(join(tmpdir(), "day-agent-repo-"));
		mkdirSync(join(home, ".8gent", "memory"), { recursive: true });
		const today = dayKey(new Date());
		const cal = join(home, "cal.ics");
		writeFileSync(
			cal,
			[
				"BEGIN:VCALENDAR",
				"BEGIN:VEVENT",
				"UID:t1",
				"SUMMARY:Dentist",
				`DTSTART:${today}T093000`,
				`DTEND:${today}T100000`,
				"END:VEVENT",
				"END:VCALENDAR",
			].join("\r\n"),
		);
		writeFileSync(join(home, ".8gent", "calendar.json"), JSON.stringify({ calendar: cal }));
		for (const [k, v] of Object.entries({
			HOME: home,
			EIGHT_HOME: home,
			EIGHT_DATA_DIR: join(home, ".8gent"),
			EIGHT_CALENDAR: undefined,
			EIGHT_TOOL_CAPABILITY_GATE: "0",
			"8GENT_TWO_STAGE_COMPACT": "0",
		})) {
			saved[k] = process.env[k];
			if (v === undefined) Reflect.deleteProperty(process.env, k);
			else process.env[k] = v;
		}
		({ Agent } = await import("./agent"));
		(await import("../hooks")).resetHookManager();
		server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(req) {
				if (req.method !== "POST") return Response.json({ models: [], data: [] });
				posts++;
				bodies.push(await req.text());
				return Response.json({
					id: "c1",
					object: "chat.completion",
					created: 0,
					model: "m",
					choices: [
						{ index: 0, message: { role: "assistant", content: "Done." }, finish_reason: "stop" },
					],
					usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
				});
			},
		});
		process.env.OLLAMA_HOST = `http://127.0.0.1:${server.port}`;
	});

	afterAll(async () => {
		server?.stop(true);
		(await import("../hooks")).resetHookManager();
		(await import("../memory/index")).resetMemoryManager();
		Reflect.deleteProperty(process.env, "OLLAMA_HOST");
		for (const [k, v] of Object.entries(saved)) {
			if (v === undefined) Reflect.deleteProperty(process.env, k);
			else process.env[k] = v;
		}
		rmSync(home, { recursive: true, force: true });
		rmSync(repo, { recursive: true, force: true });
	});

	const build = () =>
		new Agent({
			model: "m",
			runtime: "ollama",
			workingDirectory: repo,
			baseUrl: `http://127.0.0.1:${server.port}`,
			attended: true,
		} as ConstructorParameters<typeof Agent>[0]);

	test('"how does my day look today?" reads the calendar: no model call', async () => {
		posts = 0;
		const reply = await build().chat("how does my day look today?");
		expect(posts).toBe(0);
		expect(reply).toContain("09:30-10:00  Dentist");
		expect(reply).toContain("nothing left it");
	});

	test("the day never reaches the model: the next turn's request has no event title", async () => {
		const agent = build();
		const day = await agent.chat("how does my day look today?");
		expect(day).toContain("Dentist");
		bodies = [];
		await agent.chat("thanks, now summarise the readme");
		expect(bodies.length).toBeGreaterThan(0);
		for (const b of bodies) {
			expect(b).not.toContain("Dentist");
			expect(b).not.toContain("09:30");
		}
		expect(bodies.join("")).toContain("Day brief shown on the device");
	});

	test("any other message still goes to the model", async () => {
		posts = 0;
		await build().chat("summarise the readme");
		expect(posts).toBeGreaterThan(0);
	});
});
