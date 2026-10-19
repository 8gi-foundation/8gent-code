/**
 * #4417: the browser-token backstop must match the real token and profile paths, not a scratch
 * file in the work dir whose name contains "login", nor a sed regex like `.*`.
 */

import { describe, expect, test } from "bun:test";
import { preSpawnRefusal } from "../pre-spawn-backstops";

const WORK = "/tmp";

describe("pre-spawn backstop: browser tokens and profiles (#4417)", () => {
	test("sed over the scratch login file in the work dir passes", () => {
		const cmd = "sed -n 's/^\\([A-Za-z]*:\\).*/\\1/p' .tmp/login";
		expect(preSpawnRefusal(cmd, WORK)).toBeNull();
	});

	test("reading a scratch file whose name contains login passes", () => {
		expect(preSpawnRefusal("cat .tmp/login", WORK)).toBeNull();
	});

	test("the real control token path is still denied", () => {
		for (const cmd of [
			"cat ~/.8gent/browser-control.token",
			"sed -n p ~/.8gent/browser-control.token",
			"sed -n 's/a/b/p' ~/.8gent/browser-profiles/default/Cookies",
		])
			expect(preSpawnRefusal(cmd, WORK), cmd).toContain("8gent Browser control tokens or profiles");
	});
});

// #4432: only a token that holds .8gent can name the browser state. A later, unrelated token
// (a python one-liner's d['train'], the word "control") is not a path under .8gent.
const PILOT_WORK = "/Users/someone/.8gent/rishi-pilot/runs/2026-10-19_011249/sigi-dev-arc1-b/work";
const DENIED = "8gent Browser control tokens or profiles";

describe("pre-spawn backstop: a work dir under ~/.8gent is not browser state (#4432)", () => {
	test("the exact refused pilot command passes", () => {
		const cmd = `cd ${PILOT_WORK} && ls -la && cat task.json | python3 -c "import json,sys; d=json.load(sys.stdin); print('train',len(d['train']),'test',len(d['test']))"`;
		expect(preSpawnRefusal(cmd, WORK)).toBeNull();
	});

	test("other plain uses of the work dir pass", () => {
		for (const cmd of [
			`ls ${PILOT_WORK}`,
			`cat ${PILOT_WORK}/task.json | grep control`,
			`cat ${PILOT_WORK}/task.json | python3 -c "import sys; print(sys.stdin.read()[:10])"`,
			`python3 -c "print(f'{1+1}')" ${PILOT_WORK}/task.json`,
			"cat ~/.8gent/memory/notes.md",
		])
			expect(preSpawnRefusal(cmd, WORK), cmd).toBeNull();
	});

	test("the real token and profile paths stay denied: plain, brace and glob", () => {
		for (const cmd of [
			// plain
			"cat ~/.8gent/browser-control.token",
			"cat /Users/someone/.8gent/browser-control.port",
			"ls /Users/someone/.8gent/browser-profiles/default",
			"cat ~/.8gent/browser-history.json",
			"ls ~/.8gent/browser-shots",
			// brace
			"cat ~/.8gent/{browser-control.token,x}",
			"cat ~/.8gent/browser-{control,profiles}*",
			"cat ~/.8gent/{a,b}",
			// glob
			"cat ~/.8gent/browser-*",
			"cat ~/.8gent/b*",
			"cat ~/.8gent/browser-control.tok?n",
			"cat ~/.8gent/browser-[c]ontrol.token",
			"cat ~/.8gent/*token*",
			"cat ~/.8gent/$X",
			// the work dir path does not launder a later browser path
			`cd ${PILOT_WORK} && cat ~/.8gent/browser-control.token`,
			`cd ${PILOT_WORK} && cat ~/.8gent/b*`,
		])
			expect(preSpawnRefusal(cmd, WORK), cmd).toContain(DENIED);
	});
});

// Karen, #4434: a relative glob after a cd into the state dir expands to the token.
describe("pre-spawn backstop: a relative glob after a cd into ~/.8gent (#4434)", () => {
	test("cd into the state dir then a glob is denied", () => {
		for (const cmd of [
			"cd ~/.8gent && cat *",
			"cd ~/.8gent/ && cat ./*",
			'cd ~/.8gent; for f in *; do cat "$f"; done',
			"cd ~/.8gent && cat */*",
			"cd ~/.8gent && tail -n1 *",
			"cd ~/.8gent && cat -- *",
			"cd ~/.8gent && cat $PWD/*",
			"cd ~/.8gent && cat {a,b}",
			"tar -C ~/.8gent -cf x.tar *",
			"cd ~/.8gent && x=ser; cat brow$x-control.token",
			"cd ~/.8gent && cat $(printf brow)ser-control.token",
			"cd ~/.8gent && cat brow${x}ser-control.token",
			"cd ~/.8gent && cat $F",
			"cd ~/.8gent && cat */*/Cookies",
			"cd ~/.8gent && cd brow$(echo s)er-profiles && cat Default/Cookies",
			"pushd ~/.8gent && cat $(cat list.txt)",
			"HOME8=~/.8gent; cd $HOME8 && cat brow$s-control.token",
		])
			expect(preSpawnRefusal(cmd, WORK), cmd).toContain(DENIED);
	});

	test("the pilot work dir with a glob stays allowed", () => {
		expect(preSpawnRefusal("cd ~/.8gent/rishi-pilot/runs/x/work && ls *.json", WORK)).toBeNull();
	});

	test("the refusal says what to do first", () => {
		expect(preSpawnRefusal("cd ~/.8gent && cat *", WORK)).toContain(
			"Run it without touching ~/.8gent/browser-* paths",
		);
	});
});

describe("pre-spawn backstop: a .. climb from a deeper .8gent dir (#4434, Karen)", () => {
	test("a bare glob or expansion in a .. path is denied", () => {
		const W = "~/.8gent/rishi-pilot/runs/x/work";
		for (const cmd of [
			"cd ~/.8gent/rishi-pilot && cat ../*",
			"cd ~/.8gent/rishi-pilot && cat ../../*",
			"cd ~/.8gent/rishi-pilot/runs && cat ../../*",
			`cd ${W} && cat ../../../../*`,
			`cd ${W} && cat ../../../../$x`,
			"cd ~/.8gent/rishi-pilot && cat ../brow$x-control.token",
			"cd ~/.8gent/rishi-pilot && cat ../*/*/Cookies",
			"cd ~/.8gent/rishi-pilot && cd .. && cat brow$x-control.token",
			"cd ~/.8gent/rishi-pilot/runs/r/work && cat ../../../../brow${x}ser-control.token",
		])
			expect(preSpawnRefusal(cmd, WORK), cmd).toContain(DENIED);
	});

	test("a plain .. file name with no glob is not refused (no glob, token or control word to see)", () => {
		expect(
			preSpawnRefusal("cd ~/.8gent/rishi-pilot/runs/x/work && cat ../task.json", WORK),
		).toBeNull();
	});
});

describe("pre-spawn backstop: climbing out without .. (#4434, Karen)", () => {
	test("a second directory change, or a substituted cd target, is denied", () => {
		for (const cmd of [
			"cd ~/.8gent/rishi-pilot && cd $(dirname $PWD) && cat *",
			'cd ~/.8gent/rishi-pilot && cd "$(dirname $PWD)" && cat *',
			"cd ~/.8gent/rishi-pilot && cd ${PWD%/*} && cat *",
			"cd ~/.8gent/rishi-pilot && cd - && cat *",
			"cd ~/.8gent/rishi-pilot && pushd . && popd && cat *",
			"cd ~/.8gent/rishi-pilot && cd ~/x && cd ~/.8gent && cat *",
			"cd ~/.8gent/rishi-pilot && cat ~-/*",
			'cd ~/.8gent/rishi-pilot && cat "$OLDPWD"/*',
			"cd ~/.8gent/rishi-pilot && cat $(dirname $PWD)/*",
			"cd ~/.8gent/rishi-pilot && cat $(dirname $PWD)/brow$x-control.token",
			"cd ~/.8gent/rishi-pilot && cd $(dirname $PWD) && cat */*/Cookies",
			"cd ~/.8gent/rishi-pilot && cd ~- && cat brow$x-control.token",
		])
			expect(preSpawnRefusal(cmd, WORK), cmd).toContain(DENIED);
	});

	test("a work dir command that uses $HOME is a false refusal we accept", () => {
		expect(preSpawnRefusal(`cd ${PILOT_WORK} && echo $HOME`, WORK), "x").toContain(DENIED);
	});

	test("one cd with a literal work-dir target still passes", () => {
		expect(preSpawnRefusal(`cd ${PILOT_WORK} && ls -la && cat task.json`, WORK)).toBeNull();
	});
});
