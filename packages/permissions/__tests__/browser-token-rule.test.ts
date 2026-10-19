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
			`cd ${PILOT_WORK} && echo "$HOME" && python3 solve.py`,
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
