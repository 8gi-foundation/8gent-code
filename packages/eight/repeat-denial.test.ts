/**
 * #3870: a command refused twice in a turn gets a stop-retrying line, and a
 * declined command says it was declined. Neither changes what is allowed.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tempDir } from "../../tests/temp-dirs";
import { getPermissionManager } from "../permissions";
import { REPEAT_DENIAL_THRESHOLD, RepeatDenialGuard, isShellRefusal } from "./repeat-denial";
import { ToolExecutor } from "./tools";

const DENIED = "[PERMISSION DENIED] Command blocked by security policy: ffprobe x.mp4";

describe("RepeatDenialGuard", () => {
	test("the first refusal is untouched, the second tells the model to stop", () => {
		const g = new RepeatDenialGuard();
		expect(g.annotate("ffprobe x.mp4", DENIED)).toBe(DENIED);
		const second = g.annotate("ffprobe x.mp4", DENIED);
		expect(second).toStartWith(DENIED);
		expect(second).toContain("refused 2 times this turn");
		expect(second).toContain("Stop retrying it");
		expect(second).toContain("report without it");
		expect(second).toContain("unknown");
		expect(g.annotate("ffprobe x.mp4", DENIED)).toContain("refused 3 times");
		expect(REPEAT_DENIAL_THRESHOLD).toBe(2);
	});

	test("a different command has its own count", () => {
		const g = new RepeatDenialGuard();
		g.annotate("a", DENIED);
		expect(g.annotate("b", DENIED)).toBe(DENIED);
	});

	test("a new turn clears the count", () => {
		const g = new RepeatDenialGuard();
		g.annotate("a", DENIED);
		g.reset();
		expect(g.annotate("a", DENIED)).toBe(DENIED);
	});

	test("a result that is not a refusal is never touched, however often it repeats", () => {
		const g = new RepeatDenialGuard();
		for (let i = 0; i < 4; i++) expect(g.annotate("ls", "a.txt\nb.txt")).toBe("a.txt\nb.txt");
		expect(isShellRefusal("32.89\n")).toBe(false);
		expect(isShellRefusal("  [SYSTEM ONE BLOCKED] x")).toBe(true);
		expect(isShellRefusal("[BLOCKED] x")).toBe(true);
	});
});

describe("run_command through the executor", () => {
	const saved = process.env.EIGHT_SYSTEM_ONE;
	const cmd = "echo REPEAT_DENIAL_3870_PROBE";
	beforeEach(() => {
		process.env.EIGHT_SYSTEM_ONE = "0";
	});
	afterEach(() => {
		if (saved === undefined) delete process.env.EIGHT_SYSTEM_ONE;
		else process.env.EIGHT_SYSTEM_ONE = saved;
		getPermissionManager().clearSession();
	});

	test("a declined command says so, stays refused, and is told to stop on the second try", async () => {
		const pm = getPermissionManager();
		(pm as unknown as { deniedCommands: Set<string> }).deniedCommands.add(cmd.toLowerCase());
		const ex = new ToolExecutor(tempDir("repeat-denial-"));
		ex.beginTurn();
		const first = await ex.execute("run_command", { command: cmd });
		expect(first).toStartWith("[PERMISSION DENIED]");
		expect(first).toContain("declined earlier in this session");
		expect(first).not.toContain("Stop retrying");
		const second = await ex.execute("run_command", { command: cmd });
		expect(second).toStartWith("[PERMISSION DENIED]");
		expect(second).toContain("Stop retrying it");
		// Still refused: the guard only adds words.
		expect(second.startsWith("REPEAT_DENIAL_3870_PROBE")).toBe(false);
		expect(second).toContain("was not run");
		ex.beginTurn();
		expect(await ex.execute("run_command", { command: cmd })).not.toContain("Stop retrying");
	});
});
