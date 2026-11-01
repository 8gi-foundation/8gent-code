/**
 * 8SO fifth read on 8gent-code#4247 at cecc0f2b: bodies that read "checked" while they run a
 * script file the check never reads, or set a startup variable. Drop into packages/permissions/
 * next to s1-script-body.round5.test.ts. All except @P verified live on /bin/bash 3.2 with a
 * harmless evil.sh (`echo MARK_HIGH >&2`); @P needs bash 4.4+.
 *   MF1 here-doc bodies skip the allowlist: fed to a shell (round-4 function head comes back),
 *       and `$(...)` in an unquoted here-doc runs with no allowlist read.
 *   MF2 arithmetic reads a variable's value as an expression: `a[$(cmd)]` inside a quoted value
 *       runs cmd under $((x)), ((x)), ${arr[x]}, declare -i. ${x@P} runs $(...) the same way.
 *   MF3 hash -p points a plain name at a workspace script.
 *   MF4 a PATH change in a body makes a plain name a workspace script.
 *   MF5 a shell with no script operand reads its script from stdin, which the body can point
 *       at a file (`exec <evil.sh`).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDirs, tempDir } from "../../tests/temp-dirs";
import { scriptLaunch } from "./s1-script-body";

afterAll(cleanupTempDirs);
let dir = "";
beforeAll(() => {
	dir = tempDir("s1-8so-r5-");
	writeFileSync(join(dir, "ok.sh"), "echo hello\n");
	writeFileSync(join(dir, "evil.sh"), "#!/bin/bash\necho MARK_HIGH >&2\n");
	chmodSync(join(dir, "evil.sh"), 0o755);
	mkdirSync(join(dir, "bin"));
	writeFileSync(join(dir, "bin", "tool"), "#!/bin/bash\necho MARK_HIGH >&2\n");
	chmodSync(join(dir, "bin", "tool"), 0o755);
});
const bodyKind = (body: string) => {
	writeFileSync(join(dir, "run.sh"), body);
	return scriptLaunch("bash run.sh", dir, dir).kind;
};
const SPAWN = `python3 -c 'import subprocess; subprocess.run(["bash", "ok.sh"])'\n`;
const ARITH = "x='a[$(c=bash; $c evil.sh)]'\n";

describe("8SO fifth read: shapes outside the allowlist that read checked", () => {
	for (const [name, body] of [
		[
			"MF1 here-doc to a shell, function head",
			`bash <<'EOF'\nf(){ export BASH_ENV=./evil.sh; }; f\n${SPAWN}EOF\n`,
		],
		["MF1 here-doc substitution, function", "cat <<EOF\n$(f(){ bash evil.sh; }; f)\nEOF\n"],
		["MF2 $((x))", `${ARITH}echo $((x))\n`],
		["MF2 (( x ))", `${ARITH}(( x ))\n`],
		["MF2 ${arr[x]}", `${ARITH}echo "\${arr[x]}"\n`],
		["MF2 declare -i", `declare -i v\n${ARITH}v=x\n`],
		["MF2 ${x@P} (bash 4.4+)", "x='$(c=bash; $c evil.sh)'\necho \"${x@P}\"\n"],
		["MF3 hash -p", "hash -p ./evil.sh ls\nls\n"],
		["MF4 PATH=", "PATH=./bin:$PATH\ntool\n"],
		["MF4 export PATH=", 'export PATH="$PWD/bin:$PATH"\ntool\n'],
		["MF5 exec <file; bash", "exec 0<evil.sh\nbash\n"],
		["MF5 exec <file; bash -s", "exec <evil.sh\nbash -s\n"],
		["MF5 exec <file; sh", "exec <evil.sh\nsh\n"],
	] as [string, string][]) {
		test(name, () => expect(bodyKind(body)).toBe("unchecked"));
	}
});
