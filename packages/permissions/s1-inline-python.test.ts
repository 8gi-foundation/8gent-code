/**
 * #4421: a read-only inline `python3 -c "..."` (load a JSON file, print) must not raise an
 * approval card, and an inline script that writes, deletes, runs a program, reaches the
 * network or escapes through a dunder must still be asked about. The cases are the real
 * commands from the 2026-10-18 cloud sweep plus the ways round the allowlist.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { cleanupTempDirs, tempDir } from "../../tests/temp-dirs";
import { decideRules } from "../decide/rules";
import { PermissionManager } from "./index";
import { isolatedInlinePython, readOnlyInlinePython } from "./s1-inline-python";

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

const CLEAN = tempDir("inline-py-clean-");
const ok = (c: string) => readOnlyInlinePython(c, CLEAN).ok;

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
		expect(pm().checkPermission(ARC1, undefined, undefined, CLEAN)).toBe("allowed");
		expect(pm().checkPermission(ARC2, undefined, undefined, CLEAN)).toBe("allowed");
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

describe("the check needs the command's cwd (second read)", () => {
	test("no cwd given: the answer is no, ARC1 asks", () => {
		expect(readOnlyInlinePython(ARC1).ok).toBe(false);
		const m = new PermissionManager(path.join(tempDir("inline-py-"), "permissions.json"));
		expect(m.checkPermission(ARC1)).toBe("ask");
		expect(m.isAllowed(ARC1)).toBe(false);
	});
	test("sitecustomize, usercustomize and linecache shadows ask", () => {
		for (const f of ["sitecustomize.py", "usercustomize.py", "linecache.py"]) {
			const d = tempDir("inline-py-sc-");
			writeFileSync(path.join(d, f), "");
			expect(readOnlyInlinePython(ARC1, d).ok).toBe(false);
		}
	});
	// Unit level: gateShellChild is private to delegation-tools.ts, so this drives the same
	// call it makes (checkPermission with the delegated cwd) rather than the spawn path.
	test("delegated cwd with a planted json.py asks even when the daemon cwd is clean", () => {
		const m = new PermissionManager(path.join(tempDir("inline-py-"), "permissions.json"));
		const delegated = tempDir("inline-py-deleg-");
		writeFileSync(path.join(delegated, "json.py"), "");
		expect(m.checkPermission(ARC1, undefined, undefined, delegated)).toBe("ask");
		expect(m.checkPermission(ARC1, undefined, undefined, CLEAN)).toBe("allowed");
	});
});

describe("an admitted command runs isolated (-I), which closes the shadow class", () => {
	test("the admitted command carries -I after the interpreter; ARC1 and ARC2 stay admitted", () => {
		for (const c of [ARC1, ARC2]) {
			expect(ok(c)).toBe(true);
			const run = isolatedInlinePython(c);
			expect(run.startsWith("python3 -I -c ")).toBe(true);
			expect(run.slice("python3 -I -c ".length)).toBe(c.slice("python3 -c ".length));
		}
		expect(isolatedInlinePython(`python -I -c "print(1)"`)).toBe(`python -I -c "print(1)"`);
	});
	test("a non-python line is unchanged; a shaped line gets -I whether or not the allowlist admits it", () => {
		const w = `python3 -c "open('x', 'w').write('1')"`;
		expect(isolatedInlinePython(w)).toBe(w.replace("python3 -c", "python3 -I -c"));
		expect(isolatedInlinePython("python3 analyze.py")).toBe("python3 analyze.py");
		expect(isolatedInlinePython("ls -la")).toBe("ls -la");
	});

	// Real python3: each planted stub writes a marker file if it is imported.
	const MODS = ["traceback", "linecache", "json", "sitecustomize"];
	const plant = () => {
		const d = tempDir("inline-py-run-");
		for (const m of MODS) {
			const marker = JSON.stringify(path.join(d, `ran-${m}`));
			writeFileSync(path.join(d, `${m}.py`), `open(${marker}, 'w').write('x')\n`);
		}
		return d;
	};
	const marks = (d: string) => MODS.filter((m) => existsSync(path.join(d, `ran-${m}`)));
	const run = (cmd: string, cwd: string) =>
		spawnSync("/bin/sh", ["-c", cmd], {
			cwd,
			encoding: "utf8",
			env: {
				...process.env,
				PATH: `${process.env.PATH ?? ""}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`,
			},
		});
	const RAISE = `python3 -c "import json; print(open('nonexist.txt').read())"`;

	test("without -I the planted modules execute (the mechanism is real)", () => {
		const d = plant();
		run(RAISE, d);
		expect(marks(d).length).toBeGreaterThan(0); // 3.14 runs a planted linecache before -c even starts
	});
	test("with -I, the rewritten command never runs a planted module, even on the error path", () => {
		const d = plant();
		const rewritten = isolatedInlinePython(RAISE);
		expect(rewritten).toContain(" -I -c ");
		const r = run(rewritten, d);
		expect(r.status).not.toBe(0); // it raised, so python took its traceback path
		expect(marks(d)).toEqual([]);
	});
});

describe("check-then-spawn race: the rewrite does not look at the directory", () => {
	test("admitted in a clean dir, traceback.py lands, the rewrite still carries -I and the planted file never runs", () => {
		const d = tempDir("inline-py-race-");
		const line = `python3 -c "import json; print(json.loads('1'))"`;
		expect(readOnlyInlinePython(line, d).ok).toBe(true); // the permission check
		const marker = path.join(d, "ran-traceback");
		writeFileSync(
			path.join(d, "traceback.py"),
			`open(${JSON.stringify(marker)}, 'w').write('x')\n`,
		);
		expect(readOnlyInlinePython(line, d).ok).toBe(false); // a re-check would now say no
		const rewritten = isolatedInlinePython(line); // the spawn-time rewrite
		expect(rewritten).toBe(`python3 -I -c "import json; print(json.loads('1'))"`);
		const r = spawnSync("/bin/sh", ["-c", rewritten], {
			cwd: d,
			encoding: "utf8",
			env: {
				...process.env,
				PATH: `${process.env.PATH ?? ""}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`,
			},
		});
		expect(r.stdout.trim()).toBe("1");
		expect(existsSync(marker)).toBe(false);
	});
});
