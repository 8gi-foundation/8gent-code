/**
 * #4920: the Linux read boundary when the Landlock helper cannot finish.
 *
 * Artale measured on a phone (kernel 5.15.180-android13): landlock_create_ruleset is killed by
 * seccomp with SIGSYS, not ENOSYS. These tests run the real probe (a real child process, through
 * landlockStatus -> osReadRuleStatus -> osReadRefusal / osReadNotice, and through run_command on
 * Linux) with a stub in place of python3 that dies by signal, exits abnormally, or is missing.
 * Only the python3 lookup and the platform name are injected; nothing else is faked. Signal 31 is
 * SIGSYS on Linux and Android; `kill -31` is how a stub raises it on any host.
 *
 * What must hold:
 *  1. a helper killed by SIGSYS (or any signal) cannot take 8gent down: the probe is a child;
 *  2. EIGHT_OS_READ_BOUNDARY=1 and a helper that died or exited abnormally: the command is
 *     refused with the reason, and never runs;
 *  3. auto: the command runs, with a notice that names the reason;
 *  4. no python3 (stock Termux): the same, and no line says to install anything.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { ToolExecutor } from "../eight/tools";
import {
	TRANSIENT_RETRY_MS,
	_resetLandlockStatus,
	_setLandlockPython,
	landlockStatus,
} from "./landlock";
import {
	OS_READ_BOUNDARY_FLAG,
	_resetReadNotice,
	osReadNotice,
	osReadRefusal,
	osReadRuleStatus,
} from "./run-command-sandbox";
import { SYSTEM_ONE_FLAG } from "./system-one-gate";

let dir: string;
const saved = process.env[OS_READ_BOUNDARY_FLAG];
let savedSystemOne: string | undefined;

/** A stand-in for python3: an executable shell script. */
function stub(name: string, body: string): string {
	const p = path.join(dir, name);
	fs.writeFileSync(p, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
	return p;
}

beforeAll(() => {
	// Under the repo's .tmp, as the other read-boundary tests do, so the run_command text checks see a project.
	const repoTmp = path.resolve(import.meta.dir, "..", "..", ".tmp");
	fs.mkdirSync(repoTmp, { recursive: true });
	dir = fs.realpathSync(fs.mkdtempSync(path.join(repoTmp, "landlock-sigsys-")));
	savedSystemOne = process.env[SYSTEM_ONE_FLAG];
	process.env[SYSTEM_ONE_FLAG] = "0";
});
afterAll(() => {
	fs.rmSync(dir, { recursive: true, force: true });
	if (savedSystemOne === undefined) Reflect.deleteProperty(process.env, SYSTEM_ONE_FLAG);
	else process.env[SYSTEM_ONE_FLAG] = savedSystemOne;
	if (saved === undefined) Reflect.deleteProperty(process.env, OS_READ_BOUNDARY_FLAG);
	else process.env[OS_READ_BOUNDARY_FLAG] = saved;
});
beforeEach(() => {
	_resetLandlockStatus();
	_resetReadNotice();
});
afterEach(() => {
	_setLandlockPython();
	_resetLandlockStatus();
	_resetReadNotice();
	Reflect.deleteProperty(process.env, OS_READ_BOUNDARY_FLAG);
});

/** The rule on Linux, whatever machine runs the test (the platform name is the only thing passed in). */
const status = () => osReadRuleStatus("linux");
const mode = (v: "1" | "auto") => {
	process.env[OS_READ_BOUNDARY_FLAG] = v;
};

describe("a helper killed by SIGSYS", () => {
	test("the probe runs in a child: 8gent lives, and the answer is the seccomp reason", () => {
		_setLandlockPython(() => stub("sigsys.sh", "kill -31 $$"));
		const s = status();
		expect(s.active).toBe(false);
		if (!s.active) expect(s.reason).toMatch(/seccomp.*SIGSYS/);
	});

	test("a SIGSYS answer will not change, so the probe is not run again", () => {
		const log = path.join(dir, "runs.log");
		fs.rmSync(log, { force: true });
		_setLandlockPython(() => stub("sigsys-count.sh", `echo x >> ${log}\nkill -31 $$`));
		status();
		status();
		status();
		expect(fs.readFileSync(log, "utf8").trim().split("\n")).toHaveLength(1);
	});

	test("EIGHT_OS_READ_BOUNDARY=1: refused, with the reason and both ways out", () => {
		_setLandlockPython(() => stub("sigsys.sh", "kill -31 $$"));
		mode("1");
		const msg = osReadRefusal(status) ?? "";
		expect(msg).toContain("[PERMISSION DENIED] Not run");
		expect(msg).toMatch(/seccomp.*SIGSYS/);
		expect(msg).toContain(`${OS_READ_BOUNDARY_FLAG}=auto`);
	});

	test("auto: no refusal; one notice per session that names SIGSYS", () => {
		_setLandlockPython(() => stub("sigsys.sh", "kill -31 $$"));
		mode("auto");
		expect(osReadRefusal(status)).toBeUndefined();
		expect(osReadNotice(status)).toMatch(/not active here \(.*SIGSYS.*\)/);
		expect(osReadNotice(status)).toBeUndefined();
	});

	test.if(process.platform === "linux")(
		"run_command, 1: nothing runs; auto: it runs with the notice",
		async () => {
			const marker = path.join(dir, "ran-marker");
			fs.rmSync(marker, { force: true });
			_setLandlockPython(() => stub("sigsys.sh", "kill -31 $$"));
			const ex = new ToolExecutor(dir);
			mode("1");
			const refused = (await ex.execute("run_command", { command: "touch ran-marker" })) as string;
			expect(refused).toContain("Not run");
			expect(refused).toMatch(/SIGSYS/);
			expect(fs.existsSync(marker)).toBe(false);
			mode("auto");
			const ran = (await ex.execute("run_command", { command: "touch ran-marker" })) as string;
			expect(ran).toMatch(/\[notice\].*SIGSYS/);
			expect(fs.existsSync(marker)).toBe(true);
		},
	);
});

describe("a helper killed by another signal, or exiting abnormally", () => {
	test("killed (an out-of-memory kill looks like this): not the SIGSYS answer, tried again later, refused meanwhile", () => {
		_setLandlockPython(() => stub("kill9.sh", "kill -KILL $$"));
		let t = 1_000;
		const first = landlockStatus("linux", undefined, () => t);
		expect(first.active).toBe(false);
		if (!first.active) expect(first.reason).toMatch(/did not finish.*SIGKILL.*tried again/);
		// the retry window: a second look inside it does not probe again
		expect(landlockStatus("linux", undefined, () => t)).toBe(first);
		t += TRANSIENT_RETRY_MS + 1;
		expect(landlockStatus("linux", undefined, () => t)).not.toBe(first);
	});

	test("killed: 1 refuses with the reason", () => {
		_setLandlockPython(() => stub("kill9.sh", "kill -KILL $$"));
		mode("1");
		const msg = osReadRefusal(status) ?? "";
		expect(msg).toContain("Not run");
		expect(msg).toMatch(/did not finish.*SIGKILL/);
	});

	test("exits with an error code: refused with that code and what it wrote, not 'kernel does not support Landlock'", () => {
		_setLandlockPython(() => stub("exit7.sh", "echo helper-boom >&2\nexit 7"));
		const s = status();
		expect(s.active).toBe(false);
		if (!s.active) {
			expect(s.reason).toContain("exit 7");
			expect(s.reason).toContain("helper-boom");
			expect(s.reason).not.toMatch(/does not support/);
		}
		mode("1");
		const msg = osReadRefusal(status) ?? "";
		expect(msg).toContain("Not run");
		expect(msg).toContain("exit 7");
	});

	test("exit 3 is still the clean answer: this kernel has no Landlock", () => {
		_setLandlockPython(() => stub("exit3.sh", "exit 3"));
		const s = status();
		expect(s.active).toBe(false);
		if (!s.active) expect(s.reason).toMatch(/does not support Landlock/);
	});

	test("exits 0 but prints no ABI: not trusted", () => {
		_setLandlockPython(() => stub("silent.sh", "exit 0"));
		expect(status().active).toBe(false);
	});

	test("auto with an abnormal exit: runs with a notice naming the exit", () => {
		_setLandlockPython(() => stub("exit7.sh", "exit 7"));
		mode("auto");
		expect(osReadRefusal(status)).toBeUndefined();
		expect(osReadNotice(status)).toContain("exit 7");
	});
});

describe("no python3 (stock Termux)", () => {
	const NO_INSTALL = /install|pkg |apt|brew|pip|download|pull/i;

	test("the reason says python3 is missing", () => {
		_setLandlockPython(() => undefined);
		const s = status();
		expect(s.active).toBe(false);
		if (!s.active) expect(s.reason).toMatch(/python3 not found/);
	});

	test("1: refused with the reason; auto: runs with a notice; neither says to install anything", () => {
		_setLandlockPython(() => undefined);
		mode("1");
		const refusal = osReadRefusal(status) ?? "";
		expect(refusal).toContain("Not run");
		expect(refusal).toContain("python3 not found");
		expect(refusal).not.toMatch(NO_INSTALL);
		mode("auto");
		expect(osReadRefusal(status)).toBeUndefined();
		const notice = osReadNotice(status) ?? "";
		expect(notice).toContain("python3 not found");
		expect(notice).not.toMatch(NO_INSTALL);
	});

	test("nothing is spawned to look for it", () => {
		const log = path.join(dir, "spawned.log");
		fs.rmSync(log, { force: true });
		let asked = 0;
		_setLandlockPython(() => {
			asked++;
			return undefined;
		});
		status();
		expect(asked).toBe(1);
		expect(fs.existsSync(log)).toBe(false);
	});

	test.if(process.platform === "linux")(
		"run_command, 1: nothing runs; auto: it runs; no install text either way",
		async () => {
			const marker = path.join(dir, "ran-marker");
			fs.rmSync(marker, { force: true });
			_setLandlockPython(() => undefined);
			const ex = new ToolExecutor(dir);
			mode("1");
			const refused = (await ex.execute("run_command", { command: "touch ran-marker" })) as string;
			expect(refused).toContain("Not run");
			expect(refused).toContain("python3 not found");
			expect(refused).not.toMatch(NO_INSTALL);
			expect(fs.existsSync(marker)).toBe(false);
			mode("auto");
			const ran = (await ex.execute("run_command", { command: "touch ran-marker" })) as string;
			expect(ran).toContain("python3 not found");
			expect(ran).not.toMatch(NO_INSTALL);
			expect(fs.existsSync(marker)).toBe(true);
		},
	);
});
