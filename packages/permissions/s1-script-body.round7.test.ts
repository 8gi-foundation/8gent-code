/** 8GO second read of #4247: a command in a one-line case arm is read like any other. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDirs, tempDir } from "../../tests/temp-dirs";
import { scriptLaunch } from "./s1-script-body";

afterAll(cleanupTempDirs);
let dir = "";
beforeAll(() => {
	dir = tempDir("s1-8go-r7-");
	writeFileSync(join(dir, "evil.sh"), "#!/bin/bash\necho MARK_HIGH >&2\n");
	chmodSync(join(dir, "evil.sh"), 0o755);
	writeFileSync(join(dir, "ok.sh"), "echo hello\n");
});
const bodyKind = (body: string) => {
	writeFileSync(join(dir, "run.sh"), body);
	return scriptLaunch("bash run.sh", dir, dir).kind;
};

const SHAPES: [string, string][] = [
	["bash FILE", "case x in x) bash evil.sh;; esac"],
	["./FILE", "case x in x) ./evil.sh;; esac"],
	["quoted pattern", "case x in 'x') bash evil.sh;; esac"],
	["star pattern", "case x in *) bash evil.sh;; esac"],
	["inside if", "if true; then case x in x) bash evil.sh;; esac; fi"],
	["inside while", "while true; do case x in x) bash evil.sh;; esac; done"],
	["dot source", "case x in x) . evil.sh;; esac"],
	["source", "case x in x) source evil.sh;; esac"],
	["startup var", "case x in x) BASH_ENV=evil.sh bash -c true;; esac"],
	["alt pattern", "case x in a|x) bash evil.sh;; esac"],
];

describe("8GO second read: case arms", () => {
	for (const [name, line] of SHAPES) {
		test(`body: ${name} is not checked`, () => {
			expect(bodyKind(`${line}\n`)).not.toBe("checked");
		});
		test(`command line: ${name} is not none`, () => {
			expect(scriptLaunch(line, dir, dir).kind).not.toBe("none");
		});
	}
	test("control: a one-line case with a harmless command is still checked", () => {
		expect(bodyKind("case x in x) echo hello;; esac\n")).toBe("checked");
	});
	test("control: no launch on the command line stays none", () => {
		expect(scriptLaunch("case x in x) echo hello;; esac", dir, dir).kind).toBe("none");
	});
});
