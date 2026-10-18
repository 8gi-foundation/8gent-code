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
