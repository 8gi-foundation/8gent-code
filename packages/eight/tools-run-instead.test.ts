/**
 * #4102 (8SO): ToolExecutor.runCommand opts in to System One's runInstead (run the checked script
 * bytes, not the file) only when it runs with process.env, the same env the gate checked. A caller
 * that passes its own env (the done gate's runGatedCommand) runs the command as given and never gets
 * the tg-notify lane's allow, so the lane's PATH, SHELLOPTS and PS4 checks never read a different
 * env from the one that runs.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDecider } from "../decide/index";
import type { DecideBackend, SystemOneRequest, SystemOneResponse } from "../decide/types";
import { _resetSystemOne, _setSystemOneOverridesForTests } from "../permissions/system-one-gate";
import { ToolExecutor } from "./tools";

const TOKEN = "8000000001:pilot-local-stub-not-a-real-token";
const SCRIPT =
	'#!/bin/sh\n. ~/.config/tg-notify/bot.env\ncurl -sS -X POST "$TELEGRAM_API_BASE/bot$TELEGRAM_BOT_TOKEN/sendMessage" --data-urlencode "chat_id=-1004417730052" --data-urlencode "text@.tmp/msg.txt"\n';

class AlwaysDangerous implements DecideBackend {
	readonly name = "stub";
	readonly model = "always-dangerous";
	async ask(request: SystemOneRequest): Promise<SystemOneResponse> {
		return {
			answers: [
				{
					id: request.questions[0].id,
					kind: "noul",
					probabilities: { yes: 0.99 },
					confidence: 0.99,
				},
			],
			backend: this.name,
			model: this.model,
			latencyMs: 0,
		};
	}
}

type Hooks = { executeHooks: (type: string, data: { command?: string }) => Promise<unknown> };
type PM = { checkPermission: (command: string) => string };

/** The builder's own sandbox sets proxy variables; the lane rightly refuses curl under them. */
const PROXY = /^(https?|all|ftp|grpc|rsync|no|docker_https?)_proxy$/i;
const savedProxy: Record<string, string | undefined> = {};
const savedHome = process.env.HOME;
/** The test preload turns System One off; this file needs it on, in default mode. */
const savedFlag = process.env.EIGHT_SYSTEM_ONE;
const savedHeadless = process.env.EIGHT_HEADLESS;
let ws: string;
let home: string;
let ran: string[];
let pm: PM;
let hooks: Hooks;
let origCheck: PM["checkPermission"];
let origHooks: Hooks["executeHooks"];
let executor: ToolExecutor;
let calls: number;
let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
	process.env.EIGHT_HEADLESS = "1";
	Reflect.deleteProperty(process.env, "EIGHT_SYSTEM_ONE");
	for (const k of Object.keys(process.env)) {
		if (!PROXY.test(k)) continue;
		savedProxy[k] = process.env[k];
		Reflect.deleteProperty(process.env, k);
	}
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch() {
			calls++;
			return Response.json({ ok: true, result: { message_id: 1 } });
		},
	});
});
afterAll(() => {
	server.stop(true);
	if (savedFlag !== undefined) process.env.EIGHT_SYSTEM_ONE = savedFlag;
	for (const [k, v] of Object.entries(savedProxy)) process.env[k] = v;
	if (savedHome === undefined) Reflect.deleteProperty(process.env, "HOME");
	else process.env.HOME = savedHome;
	if (savedHeadless === undefined) Reflect.deleteProperty(process.env, "EIGHT_HEADLESS");
	else process.env.EIGHT_HEADLESS = savedHeadless;
	_resetSystemOne();
});

beforeEach(() => {
	calls = 0;
	ws = realpathSync(mkdtempSync(join(tmpdir(), "run-instead-ws-")));
	home = realpathSync(mkdtempSync(join(tmpdir(), "run-instead-home-")));
	mkdirSync(join(ws, ".tmp"));
	writeFileSync(join(ws, ".tmp/send.sh"), SCRIPT);
	writeFileSync(join(ws, ".tmp/msg.txt"), "one\ntwo\n");
	mkdirSync(join(home, ".config/tg-notify"), { recursive: true });
	writeFileSync(
		join(home, ".config/tg-notify/bot.env"),
		`TELEGRAM_API_BASE=http://127.0.0.1:${server.port}\nTELEGRAM_BOT_TOKEN=${TOKEN}\n`,
	);
	process.env.HOME = home;
	_setSystemOneOverridesForTests({
		createDecider: () => createDecider({ backend: new AlwaysDangerous(), cacheSize: 0 }),
		askHuman: async () => null,
		calibrationDir: mkdtempSync(join(tmpdir(), "run-instead-nocal-")),
	});
	executor = new ToolExecutor(ws, "run-instead");
	// Both managers can be process singletons: save the originals and put them back after each test,
	// or every later test in this bun process runs with the deny policy off (8SO on #4102).
	pm = (executor as unknown as { permissionManager: PM }).permissionManager;
	hooks = (executor as unknown as { hookManager: Hooks }).hookManager;
	origCheck = pm.checkPermission;
	origHooks = hooks.executeHooks;
	pm.checkPermission = () => "allowed";
	ran = [];
	hooks.executeHooks = async (type, data) => {
		if (type === "afterCommand" && data.command) ran.push(data.command);
	};
});
afterEach(() => {
	pm.checkPermission = origCheck;
	hooks.executeHooks = origHooks;
	rmSync(ws, { recursive: true, force: true });
	rmSync(home, { recursive: true, force: true });
});

describe("ToolExecutor.runCommand and System One's runInstead", () => {
	test("with process.env it runs the checked script bytes, not the path", async () => {
		const out = await executor.runCommand("sh .tmp/send.sh");
		expect(ran).toEqual([SCRIPT]);
		expect(calls).toBe(1);
		expect(out).not.toContain(TOKEN);
	});
	test("with a caller's own env it does not opt in: the command runs as given, never the lane's body", async () => {
		await executor.runCommand("sh .tmp/send.sh", 30, { ...process.env, PS4: "+ " });
		expect(ran).not.toContain(SCRIPT);
		for (const c of ran) expect(c).toBe("sh .tmp/send.sh");
	});
});
