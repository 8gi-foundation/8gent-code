/**
 * Termux report, 7 Nov: `ls -lt ~/.8gent/sessions` and `wc -l` on 8gent's own session files
 * were refused as "8gent's private data". Read-only listing and counting of the sessions and
 * turns metadata is allowed; reading their contents, and the browser control token, stay denied.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "../../tests/scoped-test";
import { resetReadAllow } from "./read-allow";
import { SYSTEM_ONE_FLAG, _resetSystemOne, systemOneGate } from "./system-one-gate";
import { registerTuiApprovalHandler } from "./tui-approval-channel";

const KEYS = ["EIGHT_HEADLESS", "EIGHT_WORKSPACE_ROOT", "EIGHT_WORKSPACE_BOUNDARY", "EIGHT_HOME"];
const saved: Record<string, string | undefined> = {};
const repoTmp = path.resolve(import.meta.dir, "..", "..", ".tmp");
let base: string;
let ws: string;
let home: string;
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
	base = fs.realpathSync(fs.mkdtempSync(path.join(repoTmp, "hist-")));
	ws = path.join(base, "ws");
	home = path.join(base, "home");
	fs.mkdirSync(ws);
	for (const d of ["sessions", "turns"]) fs.mkdirSync(path.join(home, ".8gent", d), { recursive: true });
	fs.writeFileSync(path.join(home, ".8gent", "sessions", "abc.json"), '{"m":1}\n');
	fs.writeFileSync(path.join(home, ".8gent", "turns", "t1.jsonl"), "{}\n{}\n");
	fs.writeFileSync(path.join(home, ".8gent", "browser-control.token"), "tok");
	resetReadAllow();
	registerTuiApprovalHandler(async () => "deny");
	Reflect.deleteProperty(process.env, "EIGHT_HEADLESS");
});

afterEach(() => {
	registerTuiApprovalHandler(null);
	for (const k of KEYS) Reflect.deleteProperty(process.env, k);
	fs.rmSync(base, { recursive: true, force: true });
});

const gate = (command: string) =>
	systemOneGate(
		command,
		{ ...process.env, [SYSTEM_ONE_FLAG]: "0", HOME: home },
		ws,
		undefined,
		undefined,
		{ project: ws },
	);
const s = (...p: string[]) => path.join(home, ".8gent", ...p);

describe("8gent's own history, metadata only", () => {
	test("ls -lt on the sessions folder runs", async () => {
		expect((await gate(`ls -lt ${s("sessions")}`)).run).toBe(true);
	});

	test("wc -l on a session file and on turns runs", async () => {
		expect((await gate(`wc -l ${s("sessions", "abc.json")}`)).run).toBe(true);
		expect((await gate(`wc -l ${s("turns", "t1.jsonl")}`)).run).toBe(true);
	});

	test("ls piped to wc runs", async () => {
		expect((await gate(`ls ${s("sessions")} | wc -l`)).run).toBe(true);
	});

	test("reading the contents is still refused", async () => {
		for (const cmd of [
			`cat ${s("sessions", "abc.json")}`,
			`head ${s("sessions", "abc.json")}`,
			`grep m ${s("sessions", "abc.json")}`,
		]) {
			const r = await gate(cmd);
			expect([cmd, r.run]).toEqual([cmd, false]);
			expect(r.message).toContain("8gent never reads");
		}
	});

	test("a listing chained to a read is refused", async () => {
		const r = await gate(`ls ${s("sessions")} && cat ${s("sessions", "abc.json")}`);
		expect(r.run).toBe(false);
	});

	test("the browser control token and other private data stay denied, even to ls", async () => {
		for (const cmd of [`ls -l ${s("browser-control.token")}`, `wc -c ${s("browser-control.token")}`]) {
			const r = await gate(cmd);
			expect(r.run).toBe(false);
			expect(r.message).toContain("8gent never reads");
		}
	});

	test("a redirect or substitution is not a listing", async () => {
		expect((await gate(`ls ${s("sessions")} > ${s("sessions", "x")}`)).run).toBe(false);
		expect((await gate(`ls $(cat ${s("sessions", "abc.json")})`)).run).toBe(false);
	});
});
