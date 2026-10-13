/**
 * #3870: a command refused twice in a turn gets a stop-retrying line, and a
 * declined command says it was declined. Neither changes what is allowed.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tempDir } from "../../tests/temp-dirs";
import { getPermissionManager } from "../permissions";
import {
	REPEAT_DENIAL_THRESHOLD,
	RepeatDenialGuard,
	commandKey,
	isShellRefusal,
	refusalKind,
} from "./repeat-denial";
import { ToolExecutor } from "./tools";

const DENIED = "[PERMISSION DENIED] Command blocked by security policy: ffprobe x.mp4";

describe("RepeatDenialGuard", () => {
	test("the first refusal is untouched, the second tells the model to stop", () => {
		const g = new RepeatDenialGuard();
		expect(g.annotate("ffprobe x.mp4", DENIED)).toBe(DENIED);
		const second = g.annotate("ffprobe x.mp4", DENIED);
		expect(second).toStartWith(DENIED);
		expect(second).toContain("refused 2 times this turn");
		expect(second).not.toContain("will be refused again");
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

describe("normalized key, reason wording, approver", () => {
	const A = "ffprobe -v error -show_entries format=duration -of default=nk=1:nw=1 video/brief.mp4";
	const B = "ffprobe -of csv=p=0 -show_entries format=duration -v quiet video/brief.mp4";
	const JUDGE =
		"[SYSTEM ONE BLOCKED] Blocked by System One: the safety judge was unavailable and no approval channel is available, so the command was not run. Command: x";
	const DECL =
		"[PERMISSION DENIED] This command was declined earlier in this session and was not run: x";

	test("flag order and flag variations share one key; a different file does not", () => {
		expect(commandKey(A)).toBe(commandKey(B));
		expect(commandKey(A)).not.toBe(commandKey(B.replace("brief.mp4", "other.mp4")));
		expect(commandKey("ls -la")).toBe("ls");
	});

	test("a model that varies flags still gets the stop line on the second refusal", () => {
		const g = new RepeatDenialGuard();
		expect(g.annotate(A, DENIED)).toBe(DENIED);
		expect(g.annotate(B, DENIED)).toContain("Stop retrying it");
	});

	test("reasons are told apart", () => {
		expect(refusalKind(JUDGE)).toBe("transient");
		expect(refusalKind(DECL)).toBe("declined");
		expect(refusalKind(DENIED)).toBe("policy");
	});

	test("judge unavailable: may work later, never 'will be refused again'", () => {
		const g = new RepeatDenialGuard();
		g.annotate("x a.mp4", JUDGE);
		const out = g.annotate("x a.mp4", JUDGE);
		expect(out).toContain(
			"the safety judge was not ready; this may work later".replace("the safety", "The safety"),
		);
		expect(out).toContain("report it as unknown for now");
		expect(out).not.toContain("will be refused again");
	});

	test("declined: do not retry; ask only when someone can be asked", () => {
		const no = new RepeatDenialGuard();
		no.annotate("x a.mp4", DECL);
		const headless = no.annotate("x a.mp4", DECL);
		expect(headless).toContain("The user declined this. Do not retry it.");
		expect(headless).not.toContain("Ask them if it is essential");
		const yes = new RepeatDenialGuard();
		yes.annotate("x a.mp4", DECL, true);
		expect(yes.annotate("x a.mp4", DECL, true)).toContain("Ask them if it is essential");
	});

	test("with an approver the stop line points at the user; without one it does not", () => {
		const yes = new RepeatDenialGuard();
		yes.annotate("a b.txt", DENIED, true);
		expect(yes.annotate("a b.txt", DENIED, true)).toContain("ask the user to run it or approve it");
		const no = new RepeatDenialGuard();
		no.annotate("a b.txt", DENIED);
		expect(no.annotate("a b.txt", DENIED)).not.toContain("ask the user");
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
		expect(first).not.toContain("Do not retry it");
		const second = await ex.execute("run_command", { command: cmd });
		expect(second).toStartWith("[PERMISSION DENIED]");
		expect(second).toContain("The user declined this. Do not retry it.");
		// Still refused: the guard only adds words.
		expect(second.startsWith("REPEAT_DENIAL_3870_PROBE")).toBe(false);
		expect(second).toContain("was not run");
		ex.beginTurn();
		expect(await ex.execute("run_command", { command: cmd })).not.toContain("Do not retry it");
	});
});
