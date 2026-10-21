import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "../../../../packages/eight/session-manager.js";
import { withoutBangLines } from "./bang-command.js";
import { CONSULT_ID_PREFIX, runConsultCommand } from "./consult-command.js";
import {
	type SlashRegistryEntry,
	getBuiltInSlashCommands,
	mergeSlashEntries,
	resolveSlashInput,
} from "./slash-registry.js";

const SECRET_EMAIL = "sarah.connor@cyberdyne-systems.com";
const SECRET_PATH_BIT = "zenith-bank";
const QUESTION = `why does /Users/jdoe/${SECRET_PATH_BIT}/q3.pdf fail for ${SECRET_EMAIL}`;
// What the handler shows once the reply is unmasked: the person's own values.
const SHOWN = `Advice from p (m), placeholders filled in locally:\nWrite to ${SECRET_EMAIL} about /Users/jdoe/${SECRET_PATH_BIT}/q3.pdf`;

let home: string;
let realHome: string | undefined;
let persistMessages: (tabId: string, messages: any[]) => void;

beforeAll(async () => {
	realHome = process.env.HOME;
	home = mkdtempSync(join(tmpdir(), "consult-home-"));
	process.env.HOME = home; // TABS_DIR is read from HOME when the hook module loads
	({ persistMessages } = await import("../hooks/useChatTabState.js"));
});
afterAll(() => {
	process.env.HOME = realHome;
	rmSync(home, { recursive: true, force: true });
});

function filesUnder(dir: string): string[] {
	const out: string[] = [];
	for (const e of readdirSync(dir)) {
		const p = join(dir, e);
		if (statSync(p).isDirectory()) out.push(...filesUnder(p));
		else out.push(p);
	}
	return out;
}

describe("/consult line is not stored raw (#4608)", () => {
	test("it resolves to a built-in with the question as args", () => {
		const entries: SlashRegistryEntry[] = getBuiltInSlashCommands().map((c) => ({
			token: `/${c.name}`,
			name: c.name,
			canonicalName: c.name,
			description: c.description,
			kind: "builtin" as const,
			builtInName: c.name as any,
		}));
		const r = resolveSlashInput(`/consult ${QUESTION}`, mergeSlashEntries(entries, [], []));
		expect(r?.entry.kind).toBe("builtin");
		expect(r?.entry.builtInName).toBe("consult");
		expect(r?.args.join(" ")).toBe(QUESTION);
	});
});

describe("/consult reply is shown but never saved unmasked", () => {
	test("the tab file, the session store and the whole HOME hold no unmasked value", async () => {
		// The real handler, with a consult that returns the unmasked reply as the screen shows it.
		const shown: { id: string; role: "system"; content: string; timestamp: Date }[] = [];
		await runConsultCommand(QUESTION, {
			add: (l) => shown.push({ ...l, role: "system", timestamp: new Date() }),
			consult: async () => SHOWN,
		});
		// on screen: the reply, with the person's own values
		expect(shown.some((m) => m.content.includes(SECRET_EMAIL))).toBe(true);
		expect(shown.every((m) => m.id.startsWith(CONSULT_ID_PREFIX))).toBe(true);

		// a normal chat around it, as a real tab would hold
		const chat = [
			{ id: "user-1", role: "user" as const, content: "hello", timestamp: new Date() },
			...shown,
			{ id: "assistant-1", role: "assistant" as const, content: "hi", timestamp: new Date() },
		];

		// 1. tab file: the real persistMessages
		persistMessages("t1", chat);
		// 2. session store: the real SessionManager, fed the way app.tsx saves
		const mgr = new SessionManager(join(home, ".8gent", "sessions"));
		const s = mgr.create({ name: "c" });
		mgr.update(
			s.id,
			withoutBangLines(chat).map((m) => ({ role: m.role, content: m.content })),
		);

		const files = filesUnder(home);
		expect(files.length).toBeGreaterThan(1);
		const tab = files.find((f) => f.endsWith("chat-t1.json"));
		expect(tab).toBeDefined();
		expect(readFileSync(tab as string, "utf8")).toContain("hello");
		for (const f of files) {
			const text = readFileSync(f, "utf8");
			expect(text).not.toContain(SECRET_EMAIL);
			expect(text).not.toContain(SECRET_PATH_BIT);
			expect(text).not.toContain("Advice from");
		}
	});

	test("an error line is also kept off disk", async () => {
		const shown: { id: string; content: string }[] = [];
		await runConsultCommand(QUESTION, {
			add: (l) => shown.push(l),
			consult: async () => {
				throw new Error(`boom for ${SECRET_EMAIL}`);
			},
		});
		expect(shown.at(-1)?.content).toContain("boom");
		expect(shown.every((m) => m.id.startsWith(CONSULT_ID_PREFIX))).toBe(true);
		persistMessages(
			"t2",
			shown.map((m) => ({ ...m, role: "system", timestamp: new Date() })),
		);
		const f = filesUnder(home).find((x) => x.endsWith("chat-t2.json"));
		expect(readFileSync(f as string, "utf8")).not.toContain(SECRET_EMAIL);
	});

	test("control: an ordinary system line with the same text IS saved, so the test can see a leak", () => {
		persistMessages("t3", [
			{ id: "system-1", role: "system", content: SHOWN, timestamp: new Date() },
		]);
		const f = filesUnder(home).find((x) => x.endsWith("chat-t3.json"));
		expect(readFileSync(f as string, "utf8")).toContain(SECRET_EMAIL);
	});
});
