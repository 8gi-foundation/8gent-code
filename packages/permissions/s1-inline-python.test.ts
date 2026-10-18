/**
 * #4421: a read-only inline `python3 -c "..."` (load a JSON file, print) must not raise an
 * approval card, and an inline script that writes, deletes, runs a program, reaches the
 * network or escapes through a dunder must still be asked about. The cases are the real
 * commands from the 2026-10-18 cloud sweep plus the ways round the allowlist.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { cleanupTempDirs, tempDir } from "../../tests/temp-dirs";
import { decideRules } from "../decide/rules";
import { PermissionManager } from "./index";
import { readOnlyInlinePython } from "./s1-inline-python";

afterAll(cleanupTempDirs);

const ARC1 = `python3 -c "
import json
t = json.load(open('task.json'))
print('keys:', list(t.keys()))
for i, ex in enumerate(t['train']):
    inp, out = ex['input'], ex['output']
    print(f'--- train {i}: input {len(inp)}x{len(inp[0])}, output {len(out)}x{len(out[0])}')
    for r in inp: print(''.join(map(str,r)))
print('=== test input:', len(t['test']['input']), 'x', len(t['test']['input'][0]))
"`;
const ARC2 = `python3 -c "
import json
t = json.load(open('task.json'))
print(type(t['test']))
print(json.dumps(t['test'])[:500])
"`;

const ok = (c: string) => readOnlyInlinePython(c).ok;

describe("read-only inline python is allowed", () => {
	test("the two sweep commands", () => {
		expect(ok(ARC1)).toBe(true);
		expect(ok(ARC2)).toBe(true);
	});
	test("one line, single quotes, python, -I", () => {
		expect(ok(`python3 -c "import json; print(len(json.load(open('a.json'))))"`)).toBe(true);
		expect(ok(`python3 -c 'import json; print(json.load(open("a.json")))'`)).toBe(true);
		expect(ok(`python -I -c "print(1+1)"`)).toBe(true);
		expect(ok(`python3 -c "import re, collections; print(re.findall('a', 'banana'))"`)).toBe(true);
	});
	test("read mode spelled out, with-block", () => {
		expect(ok(`python3 -c "with open('a.txt', 'r') as f: print(f.read())"`)).toBe(true);
	});
});

describe("anything that writes, deletes, runs or escapes is not taken", () => {
	const bad: Record<string, string> = {
		"write mode": `python3 -c "open('x', 'w').write('hi')"`,
		"append mode": `python3 -c "open('x', 'a').write('hi')"`,
		"mode keyword": `python3 -c "open('x', mode='w')"`,
		"bare open alias": `python3 -c "f = open; f('x', 'w')"`,
		"write call": `python3 -c "import json; json.dump({}, open('x'))"`,
		"print to file": `python3 -c "print(1, file=open('x'))"`,
		"import os": `python3 -c "import os; os.remove('x')"`,
		"from os": `python3 -c "from os import remove; remove('x')"`,
		"shutil rmtree": `python3 -c "import shutil; shutil.rmtree('x')"`,
		subprocess: `python3 -c "import subprocess; subprocess.run(['ls'])"`,
		socket: `python3 -c "import socket"`,
		urllib: `python3 -c "import urllib.request"`,
		"dunder import": `python3 -c "__import__('os').system('ls')"`,
		"dunder class": `python3 -c "print(().__class__.__bases__)"`,
		exec: `python3 -c "exec('print(1)')"`,
		eval: `python3 -c "eval('1')"`,
		compile: `python3 -c "compile('1', 'x', 'eval')"`,
		getattr: `python3 -c "getattr(open, 'x')"`,
		"absolute path": `python3 -c "print(open('/etc/passwd').read())"`,
		"home path": `python3 -c "print(open('~/.ssh/id_rsa').read())"`,
		"parent path": `python3 -c "print(open('../x').read())"`,
		"env file": `python3 -c "print(open('.env').read())"`,
		"dot dir": `python3 -c "print(open('.git/config').read())"`,
		"computed path": `python3 -c "p = 'a'; print(open(p).read())"`,
		"shell expansion in dq": `python3 -c "print('$(rm -rf x)')"`,
		"backtick in dq": "python3 -c \"print('`id`')\"",
		"backslash in dq": `python3 -c "print('a\\\\b')"`,
		"second command": `python3 -c "print(1)"; rm -rf x`,
		"and-chain": `python3 -c "print(1)" && ls`,
		pipe: `python3 -c "print(1)" | sh`,
		redirect: `python3 -c "print(1)" > out.txt`,
		"extra arg": `python3 -c "print(1)" task.json`,
		"stdin script": "python3 - <<'EOF'\nprint(1)\nEOF",
		"unclosed quote": `python3 -c "print(1)`,
		"not python": `ruby -e "puts 1"`,
		"cd prefix": `cd work && python3 -c "print(1)"`,
		"unknown module": `python3 -c "import evilpkg"`,
		"input()": `python3 -c "input()"`,
		ctypes: `python3 -c "import ctypes"`,
		"sys module": `python3 -c "import sys; sys.modules"`,
		"import after semicolon": `python3 -c "print(1) ; import os"`,
	};
	for (const [name, cmd] of Object.entries(bad)) {
		test(name, () => expect(ok(cmd)).toBe(false));
	}
});

describe("PermissionManager: no card for read-only inline python, a card for the rest", () => {
	const pm = () => new PermissionManager(path.join(tempDir("inline-py-"), "permissions.json"));

	test("read-only is allowed", () => {
		expect(pm().checkPermission(ARC1)).toBe("allowed");
		expect(pm().checkPermission(ARC2)).toBe("allowed");
	});
	test("writing or deleting still asks", () => {
		const m = pm();
		expect(m.checkPermission(`python3 -c "open('x', 'w').write('hi')"`)).toBe("ask");
		expect(m.checkPermission(`python3 -c "import os; os.remove('x')"`)).toBe("ask");
		expect(m.checkPermission(`python3 -c "import shutil; shutil.rmtree('x')"`)).toBe("ask");
	});
	test("System One's rules still escalate inline code that deletes, and pass the read-only one", () => {
		expect(decideRules(`python3 -c "import os; os.remove('x')"`).verdict).toBe("escalate");
		expect(decideRules(ARC1).verdict).toBe("pass");
	});
	test("a script file still asks as before", () => {
		expect(pm().checkPermission("python3 analyze.py")).toBe("ask");
	});
});

describe("escaped dunders and format walkers are refused (8SO bypass 1)", () => {
	test("\\x5f spelling an underscore", () => {
		const env = `python3 -I -c "import json; print('{0.\\x5f_globals__[codecs].sys.modules[os].environ}'.format(json.loads))"`;
		expect(ok(env)).toBe(false);
		expect(ok(`python3 -c "print('{0.\\x5f_class__}'.format(1))"`)).toBe(false);
	});
	test("no hex, unicode, octal or named escape, in either quoting", () => {
		for (const esc of [
			"\\x41",
			"\\u0041",
			"\\U00000041",
			"\\N{LOW LINE}",
			"\\137",
			"\\0",
			"\\\\",
		]) {
			expect(ok(`python3 -c "print('a${esc}b')"`)).toBe(false);
			expect(ok(`python3 -c 'print("a${esc}b")'`)).toBe(false);
		}
	});
	test("format, format_map and the other walkers", () => {
		for (const w of [
			"'{0.real}'.format(1)",
			"'{a.real}'.format_map({'a': 1})",
			"quit()",
			"exit()",
			"int.mro()",
		]) {
			expect(ok(`python3 -c "print(${w})"`)).toBe(false);
		}
	});
	test("an f-string dunder walk is refused by the underscore rule", () => {
		expect(ok(`python3 -c "t = 1; print(f'{t.__class__}')"`)).toBe(false);
		expect(ok(`python3 -c "t = [1]; print(f'{t[0]} {len(t)}')"`)).toBe(true);
	});
	test("\\n and \\t in a print still pass", () => {
		expect(ok(`python3 -c "print('a\\nb\\tc')"`)).toBe(true);
		expect(ok(`python3 -c 'print("a\\nb")'`)).toBe(true);
	});
	test("hardened secret names", () => {
		for (const n of ["apikey.json", "auth.json", "cookie.txt", "kubeconfig"]) {
			expect(ok(`python3 -c "print(open('${n}').read())"`)).toBe(false);
		}
	});
});

describe("a planted stdlib shadow in the cwd falls back to the card (8SO bypass 2)", () => {
	const dirWith = (...files: string[]) => {
		const d = tempDir("inline-py-cwd-");
		for (const f of files) {
			const fp = path.join(d, f);
			mkdirSync(path.dirname(fp), { recursive: true });
			writeFileSync(fp, "");
		}
		return d;
	};
	test("clean cwd allows ARC1 and ARC2, with or without -I", () => {
		const d = dirWith("task.json", "solve.py");
		expect(readOnlyInlinePython(ARC1, d).ok).toBe(true);
		expect(readOnlyInlinePython(ARC2, d).ok).toBe(true);
		expect(readOnlyInlinePython(ARC2.replace("python3 ", "python3 -I "), d).ok).toBe(true);
	});
	test("json.py, re.py, math.py, collections.py, itertools.py, a package dir, a .so", () => {
		for (const f of [
			"json.py",
			"re.py",
			"math.py",
			"collections.py",
			"itertools.py",
			"json/__init__.py",
			"json.pyc",
			"json.cpython-312-darwin.so",
			"enum.py",
		]) {
			const d = dirWith(f);
			expect(readOnlyInlinePython(ARC1, d).ok).toBe(false);
		}
	});
	test("an unreadable cwd is refused", () => {
		expect(readOnlyInlinePython(ARC1, "/nonexistent-dir-4422").ok).toBe(false);
	});
	test("through PermissionManager: shadowed cwd asks, clean cwd allows", () => {
		const m = new PermissionManager(path.join(tempDir("inline-py-"), "permissions.json"));
		const bad = dirWith("json.py");
		const good = dirWith("task.json");
		expect(m.checkPermission(ARC1, undefined, undefined, bad)).toBe("ask");
		expect(m.checkPermission(ARC1, undefined, undefined, good)).toBe("allowed");
		expect(m.checkPermission(ARC2, undefined, undefined, good)).toBe("allowed");
	});
});
