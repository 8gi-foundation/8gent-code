/** 8SO Read 6 NEW-1: an integer-looking assignment must be one whole `$((...))`. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDirs, tempDir } from "../../tests/temp-dirs";
import { isIntegerValue } from "./s1-script-arith";
import { scriptLaunch } from "./s1-script-body";

afterAll(cleanupTempDirs);
let dir = "";
beforeAll(() => {
	dir = tempDir("s1-8so-r6-");
	writeFileSync(join(dir, "evil.sh"), "#!/bin/bash\necho MARK_HIGH >&2\n");
	chmodSync(join(dir, "evil.sh"), 0o755);
});
const bodyKind = (body: string) => {
	writeFileSync(join(dir, "run.sh"), body);
	return scriptLaunch("bash run.sh", dir, dir).kind;
};

describe("8SO Read 6 NEW-1: concatenated integer values are not integers", () => {
	for (const [name, body] of [
		["name", "read y < d.txt\nx=$((0))$y$((0))\necho $(( x ))\n"],
		["arg", "x=$((0))$1$((0))\n(( x ))\n"],
		["env", "x=$((0))$HOME$((0))\n(( x ))\n"],
		["sub", "x=$((0))$(cat d.txt; echo $((0)))\n(( x ))\n"],
		["quoted sub", 'x="$((0))$(cat d.txt)$((0))"\n(( x ))\n'],
	] as const)
		test(`${name} is not checked`, () => {
			expect(bodyKind(body)).not.toBe("checked");
		});

	test("positive control: x=$((1+2)) still passes", () => {
		expect(bodyKind("x=$((1+2))\necho $(( x + 1 ))\n")).toBe("checked");
	});
	test("isIntegerValue accepts plain forms, refuses stitched ones", () => {
		for (const v of ["7", "-3", "$((1+2))", '"$((a + 1))"', "$(( (1+2)*3 ))"])
			expect(isIntegerValue(v)).toBe(true);
		for (const v of [
			"$((0))$y$((0))",
			"$((0))$1$((0))",
			"$(( $(id) ))",
			"$((`id`))",
			"$((0))x",
			"a$((0))",
		])
			expect(isIntegerValue(v)).toBe(false);
	});
});
