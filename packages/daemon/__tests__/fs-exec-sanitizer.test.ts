/**
 * fs.exec runs the engine's shell chain (preSpawnRefusal, sanitizeShellCommand, blockedReason)
 * before any spawn, so the verb allowlist is never the only gate. Wipe strings are the canonical
 * ones from packages/permissions tests (#4514 families 1-5, #4485), assembled so no line here is one.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _setAuditDir } from "../routes/store/audit";
import { execRefusal, fsExec } from "../routes/store/fs";
import type { JsonRpcContext } from "../routes/store/jsonrpc";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "fs-exec-san-"));
const WORKSPACE = fs.realpathSync(fs.mkdirSync(path.join(TMP, "ws"), { recursive: true }) ?? TMP);
const MARKER = path.join(TMP, "spawned.marker");
const ctx = { socketKey: {}, notify: () => {}, initiator: "test" } as unknown as JsonRpcContext;
let savedRoot: string | undefined;
let savedLegacy: string | undefined;

beforeAll(() => {
	fs.mkdirSync(path.join(TMP, "audit"), { recursive: true });
	fs.mkdirSync(path.join(TMP, "ws"), { recursive: true });
	_setAuditDir(path.join(TMP, "audit"));
	savedRoot = process.env.EIGHT_WORKSPACE_ROOT;
	savedLegacy = process.env.EIGHT_LEGACY_BASH;
	process.env.EIGHT_WORKSPACE_ROOT = path.join(TMP, "ws");
	delete process.env.EIGHT_LEGACY_BASH;
});
afterAll(() => {
	if (savedRoot === undefined) delete process.env.EIGHT_WORKSPACE_ROOT;
	else process.env.EIGHT_WORKSPACE_ROOT = savedRoot;
	if (savedLegacy !== undefined) process.env.EIGHT_LEGACY_BASH = savedLegacy;
	fs.rmSync(TMP, { recursive: true, force: true });
});

const run = (command: string) =>
	fsExec({ command, conversationId: "c", workspaceId: "default" }, ctx) as Promise<{
		stdout: string;
		exitCode: number;
	}>;

async function refused(command: string): Promise<string> {
	type Blocked = { data?: { blocked?: boolean; reason?: string } };
	let caught: Blocked | undefined;
	try {
		await run(command);
	} catch (e) {
		caught = e as Blocked;
	}
	expect(caught).toBeDefined();
	expect((caught as Blocked).data?.blocked).toBe(true);
	return (caught as Blocked).data?.reason ?? "";
}

const RMW = ["r", "m"].join("");
const RMRF = ["rm", "-rf"].join(" ");
const DELW = ["-de", "lete"].join("");

// One or two canonical strings from each wipe-guard family, copied from the permissions tests.
const WIPES: Record<string, string[]> = {
	"home wipe (#4485)": [`${RMRF} ~`, `${RMRF} $HOME`, `true && ${RMRF} $HOME`],
	"family 1: ANSI-C escapes": [`${RMRF} $'\\x2f'`, `$'\\x72m' -rf /`, `$'rm' -rf /`],
	"family 2: brace and IFS": [`{,${RMW}} -rf /`, `r{m,x} -rf /`, `${RMW} -rf /{,}`],
	"family 3: bracket globs": [`${RMW} -rf [/]`, `${RMW} -rf /[/]`, `${RMW} -rf [[:punct:]]`],
	"family 4: delegated wipes": [
		`echo / | xargs ${RMW} -rf`,
		`find / ${DELW}`,
		`find ~ ${DELW}`,
		`xargs ${RMW} -rf <<< /`,
	],
	"family 5: variables and arrays": [
		`r=${RMW}; $r -rf /`,
		`d=/; ${RMW} -rf $d`,
		`x=${RMW}; eval $x -rf /`,
	],
};

describe("fs.exec refuses before spawn with the engine's words", () => {
	test("an unquoted heredoc redirect is refused with the sanitizer text and nothing is spawned", async () => {
		const reason = await refused(`cat > ${MARKER} << EOF\nx\nEOF`);
		expect(reason).toContain("[BLOCKED]");
		expect(reason).toContain("write_file");
		expect(fs.existsSync(MARKER)).toBe(false);
	});

	test("a quoted-file heredoc is refused too, and nothing is spawned", async () => {
		fs.mkdirSync(path.join(WORKSPACE, ".tmp"), { recursive: true });
		const reason = await refused("cat > .tmp/x.txt <<'EOF'\nx\nEOF");
		expect(reason).toContain("PERMISSION DENIED");
		expect(fs.existsSync(path.join(WORKSPACE, ".tmp", "x.txt"))).toBe(false);
	});

	test("find with its delete flag over the project is refused and the file survives", async () => {
		const victim = path.join(WORKSPACE, "victim.txt");
		fs.writeFileSync(victim, "keep");
		const reason = await refused(`find . -name victim.txt ${DELW}`);
		expect(reason).toContain("PERMISSION DENIED");
		expect(fs.existsSync(victim)).toBe(true);
	});

	test("find that runs a command is refused", async () => {
		await refused(`find . -exec touch ${MARKER} {} +`);
		expect(fs.existsSync(MARKER)).toBe(false);
	});

	test("the chain also holds under EIGHT_LEGACY_BASH=1", async () => {
		process.env.EIGHT_LEGACY_BASH = "1";
		try {
			await refused(`find . ${DELW}`);
		} finally {
			delete process.env.EIGHT_LEGACY_BASH;
		}
	});

	for (const [family, lines] of Object.entries(WIPES)) {
		test(`${family}: every canonical string is refused with the engine text`, async () => {
			for (const line of lines) {
				expect([line, execRefusal(line, WORKSPACE) !== null]).toEqual([line, true]);
				const reason = await refused(line);
				expect([line, /\[(BLOCKED|PERMISSION DENIED)\]/.test(reason)]).toEqual([line, true]);
			}
		});
	}
});

describe("fs.exec still runs plain allowed commands", () => {
	test("echo runs and returns its output", async () => {
		const r = await run("echo hello-fs-exec");
		expect(r.exitCode).toBe(0);
		expect(r.stdout.trim()).toBe("hello-fs-exec");
	});

	test("a read-only pipeline and a plain find run", async () => {
		fs.writeFileSync(path.join(WORKSPACE, "a.txt"), "one\ntwo\n");
		expect((await run("cat a.txt | wc -l")).stdout.trim()).toBe("2");
		expect((await run("find . -name a.txt")).stdout).toContain("a.txt");
	});
});
