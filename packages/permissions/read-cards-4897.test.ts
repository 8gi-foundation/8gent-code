/**
 * #4897: never ask what a yes cannot grant, and never ask twice.
 *
 * Production call shape: systemOneGate with a card responder registered on the TUI approval
 * channel (the same one the TUI uses), real files on disk. System One is off so the read
 * boundary alone decides; it runs in every mode.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { readCardsShown, resetReadAllow } from "./read-allow";
import { osReadSpec } from "./read-boundary";
import { SYSTEM_ONE_FLAG, _resetSystemOne, systemOneGate } from "./system-one-gate";
import { registerTuiApprovalHandler } from "./tui-approval-channel";

const KEYS = ["EIGHT_HEADLESS", "EIGHT_WORKSPACE_ROOT", "EIGHT_WORKSPACE_BOUNDARY"];
const saved: Record<string, string | undefined> = {};
const repoTmp = path.resolve(import.meta.dir, "..", "..", ".tmp");
let base: string;
let ws: string;
let cards: { action: string; details: string; command: string }[];
let ttyWas: PropertyDescriptor | undefined;

beforeAll(() => {
	for (const k of KEYS) saved[k] = process.env[k];
	for (const k of KEYS) Reflect.deleteProperty(process.env, k);
	fs.mkdirSync(repoTmp, { recursive: true });
	ttyWas = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
	Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
});

afterAll(() => {
	for (const k of KEYS) {
		if (saved[k] === undefined) Reflect.deleteProperty(process.env, k);
		else process.env[k] = saved[k];
	}
	if (ttyWas) Object.defineProperty(process.stdin, "isTTY", ttyWas);
	else Reflect.deleteProperty(process.stdin, "isTTY");
	registerTuiApprovalHandler(null);
	_resetSystemOne();
});

beforeEach(() => {
	base = fs.realpathSync(fs.mkdtempSync(path.join(repoTmp, "rc4897-")));
	ws = path.join(base, "ws");
	fs.mkdirSync(ws);
	cards = [];
	resetReadAllow();
	Reflect.deleteProperty(process.env, "EIGHT_HEADLESS");
});

afterEach(() => {
	registerTuiApprovalHandler(null);
	Reflect.deleteProperty(process.env, "EIGHT_HEADLESS");
	fs.rmSync(base, { recursive: true, force: true });
});

function outsideDir(name: string, files: string[]): string {
	const d = path.join(base, name);
	fs.mkdirSync(d, { recursive: true });
	for (const f of files) fs.writeFileSync(path.join(d, f), "x");
	return d;
}

function responder(reply: "approve" | "deny"): void {
	registerTuiApprovalHandler(async (req) => {
		cards.push({ action: req.action, details: req.details, command: req.command ?? "" });
		return reply;
	});
}

function headless(): void {
	registerTuiApprovalHandler(null);
	process.env.EIGHT_HEADLESS = "1";
}

const gate = (command: string, env: Record<string, string | undefined> = {}) =>
	systemOneGate(
		command,
		{ ...process.env, [SYSTEM_ONE_FLAG]: "0", ...env },
		ws,
		undefined,
		undefined,
		{
			project: ws,
		},
	);

describe("one card per file, one card per command", () => {
	test("three reads of the same outside file produce one card", async () => {
		const d = outsideDir("docs", ["a"]);
		responder("approve");
		for (let i = 0; i < 3; i++) expect((await gate(`cat ${path.join(d, "a")}`)).run).toBe(true);
		expect(cards.length).toBe(1);
		expect(readCardsShown()).toBe(1);
	});

	test("a yes to one file does not open its siblings: they are asked about", async () => {
		const d = outsideDir("docs", ["a", "b", ".env"]);
		responder("approve");
		await gate(`cat ${path.join(d, "a")}`);
		expect(cards.length).toBe(1);
		await gate(`cat ${path.join(d, "b")}`);
		expect(cards.length).toBe(2);
		await gate(`cat ${path.join(d, ".env")}`);
		expect(cards.length).toBe(3);
	});

	test("the card names exactly what a yes opens", async () => {
		const d = outsideDir("docs", ["a"]);
		responder("approve");
		await gate(`cat ${path.join(d, "a")}`);
		expect(cards[0].details).toContain(
			`A yes opens the file ${path.join(d, "a")} for this session.`,
		);
		expect(cards[0].details).not.toContain("everything under");
	});

	test("a folder the command names is remembered with everything under it, and the card says so", async () => {
		const d = outsideDir("proj", ["a", "b"]);
		responder("approve");
		await gate(`ls ${d}`);
		expect(cards[0].details).toContain(`the folder ${d} and everything under it`);
		expect((await gate(`cat ${path.join(d, "b")}`)).run).toBe(true);
		expect(cards.length).toBe(1);
	});

	test("a folder holding a credential-shaped name is read once, not remembered", async () => {
		const d = outsideDir("withenv", ["a", ".env"]);
		responder("approve");
		await gate(`ls ${d}`);
		expect(cards[0].details).toContain("this one time only");
		await gate(`cat ${path.join(d, "a")}`);
		expect(cards.length).toBe(2);
	});

	test("a yes to the home folder itself opens nothing for later", async () => {
		const home = path.join(base, "home");
		fs.mkdirSync(path.join(home, "Documents"), { recursive: true });
		fs.writeFileSync(path.join(home, "Documents", "n.txt"), "x");
		responder("approve");
		await gate(`ls ${home}`, { HOME: home });
		expect(cards[0].details).toContain("this one time only");
		await gate(`cat ${path.join(home, "Documents", "n.txt")}`, { HOME: home });
		expect(cards.length).toBe(2);
	});

	test("the file's remembered yes is the file, at the kernel rule too", async () => {
		const d = outsideDir("kernel", ["a", "b"]);
		responder("approve");
		await gate(`cat ${path.join(d, "a")}`);
		process.env.EIGHT_OS_READ_BOUNDARY = "1";
		try {
			const spec = osReadSpec(`cat ${path.join(d, "b")}`, { cwd: ws, project: ws });
			expect(spec?.reads).toContain(path.join(d, "a"));
			expect(spec?.reads).not.toContain(d);
		} finally {
			Reflect.deleteProperty(process.env, "EIGHT_OS_READ_BOUNDARY");
		}
	});

	test("a command reading several outside paths shows exactly one card that lists them all", async () => {
		const d1 = outsideDir("one", ["a", "b"]);
		const d2 = outsideDir("two", ["c", "d"]);
		const all = [path.join(d1, "a"), path.join(d1, "b"), path.join(d2, "c"), path.join(d2, "d")];
		responder("approve");
		const r = await gate(`cat ${all.join(" ")}`);
		expect(r.run).toBe(true);
		expect(cards.length).toBe(1);
		for (const p of all) expect(cards[0].details).toContain(p);
		expect(cards[0].details).not.toContain("...");
	});

	test("after a yes, a sibling path in a different outside folder is still asked", async () => {
		const d1 = outsideDir("one", ["a"]);
		const d2 = outsideDir("two", ["b"]);
		responder("approve");
		await gate(`cat ${path.join(d1, "a")}`);
		expect(cards.length).toBe(1);
		await gate(`cat ${path.join(d2, "b")}`);
		expect(cards.length).toBe(2);
		expect(readCardsShown()).toBe(2);
	});

	test("a no is not remembered: the same path is asked again", async () => {
		const d = outsideDir("docs", ["a"]);
		responder("deny");
		expect((await gate(`cat ${path.join(d, "a")}`)).run).toBe(false);
		expect((await gate(`cat ${path.join(d, "a")}`)).run).toBe(false);
		expect(cards.length).toBe(2);
	});

	test("the remembered yes reaches the kernel read rule for later commands", async () => {
		const d = outsideDir("docs2", ["a"]);
		responder("approve");
		await gate(`cat ${path.join(d, "a")}`);
		process.env.EIGHT_OS_READ_BOUNDARY = "1";
		try {
			const spec = osReadSpec(`cat ${path.join(d, "a")}`, { cwd: ws, project: ws });
			expect(spec?.reads).toContain(path.join(d, "a"));
		} finally {
			Reflect.deleteProperty(process.env, "EIGHT_OS_READ_BOUNDARY");
		}
	});
});

describe("never-read paths get no card", () => {
	test("a credential path is refused in one plain sentence, zero cards", async () => {
		const home = path.join(base, "home");
		fs.mkdirSync(path.join(home, ".ssh"), { recursive: true });
		fs.writeFileSync(path.join(home, ".ssh", "id_ed25519"), "k");
		responder("approve");
		const r = await gate(`cat ${path.join(home, ".ssh", "id_ed25519")}`, { HOME: home });
		expect(r.run).toBe(false);
		expect(r.message).toContain("8gent never reads credential files such as ~/.ssh");
		expect(cards.length).toBe(0);
		expect(readCardsShown()).toBe(0);
	});

	test("the private 8gent data is refused with no card, even beside a path that would be asked", async () => {
		const home = path.join(base, "home");
		fs.mkdirSync(path.join(home, ".8gent"), { recursive: true });
		fs.writeFileSync(path.join(home, ".8gent", "memory.db"), "m");
		const d = outsideDir("docs", ["a"]);
		responder("approve");
		const r = await gate(`cat ${path.join(d, "a")} ${path.join(home, ".8gent", "memory.db")}`, {
			HOME: home,
		});
		expect(r.run).toBe(false);
		expect(r.message).toContain("8gent never reads 8gent's private data");
		expect(cards.length).toBe(0);
	});
});

describe("headless", () => {
	test("with nobody to answer, an outside read is refused and no card is counted", async () => {
		const d = outsideDir("docs", ["a"]);
		headless();
		const r = await gate(`cat ${path.join(d, "a")}`);
		expect(r.run).toBe(false);
		expect(r.message).toContain("headless");
		expect(cards.length).toBe(0);
		expect(readCardsShown()).toBe(0);
	});
});
