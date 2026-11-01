import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { validatePath } from "./path-guard";
import { checkCommandBoundary, checkFilePathBoundary } from "./src/workspace-boundary";

type Row = [command: string, allowed: boolean];

const WIN_WS = "C:\\Users\\dev\\proj";
const WIN_HOST = {
	platform: "win32" as const,
	env: { USERPROFILE: "C:\\Users\\dev", PATH: "C:\\Windows\\system32;C:\\Program Files\\Git\\cmd" },
};

const WIN32_COMMANDS: Row[] = [
	["type C:\\Users\\dev\\secret.txt", false],
	["cat C:/Users/dev/secret.txt", false],
	["type ..\\..\\secret.txt", false],
	["type .\\..\\secret.txt", false],
	["type ..", false],
	["type \\\\server\\share\\x.txt", false],
	["type //server/share/x.txt", false],
	["type \\\\?\\C:\\Windows\\win.ini", false],
	["type \\Windows\\win.ini", false],
	["type D:secret.txt", false],
	["type D:\\secret.txt", false],
	["type %USERPROFILE%\\.ssh\\id_rsa", false],
	["type %userprofile%\\.ssh\\id_rsa", false],
	["Get-Content $env:USERPROFILE\\.ssh\\id_rsa", false],
	["cat ~\\.ssh\\id_rsa", false],
	["cat ~/.ssh/id_rsa", false],
	["type C:\\Users\\dev\\proj\\..\\secret.txt", false],
	["type C:\\Users\\dev\\proj-other\\a.txt", false],
	["copy src\\a.txt C:\\Windows\\a.txt", false],
	["Get-Content -Path C:\\Users\\dev\\secret.txt", false],
	["Get-Content -Path:C:\\Users\\dev\\secret.txt", false],
	["type C:^\\Users^\\dev^\\secret.txt", false],
	["type C:\\Users\\dev\\proj\\src\\..`\\..`\\secret.txt", false],
	["cd src & type ..\\..\\secret.txt", false],
	["cd src\ntype ..\\..\\secret.txt", false],
	["cd .. && type secret.txt", false],
	["cat C\\:\\\\Users\\\\dev\\\\secret.txt", false],
	["type C:\\Users\\dev\\proj\\src\\main.ts", true],
	["type c:\\users\\DEV\\Proj\\src\\main.ts", true],
	["type C:/Users/dev/proj/src/main.ts", true],
	["type C:\\Users\\dev\\proj/src\\main.ts", true],
	// Git Bash reads this spelling as a path at the drive root.
	["type \\\\?\\C:\\Users\\dev\\proj\\src\\main.ts", false],
	['type "C:\\Users\\dev\\proj\\my docs\\notes.txt"', true],
	["type src\\main.ts", true],
	["type .\\src\\main.ts", true],
	["cd src && type ..\\README.md", true],
	["type %USERPROFILE%\\proj\\src\\main.ts", true],
	["echo %PATH%", true],
	["git status", true],
];

const POSIX_WS = "/home/dev/proj";
const POSIX_HOST = {
	platform: "linux" as const,
	env: { HOME: "/home/dev", PATH: "/usr/bin:/bin:/home/dev/.local/bin" },
};

const POSIX_COMMANDS: Row[] = [
	["cat /etc/passwd", false],
	["cat ../secret.txt", false],
	["cat ~/.ssh/id_rsa", false],
	["cat $HOME/.ssh/id_rsa", false],
	["cat ${HOME}/.ssh/id_rsa", false],
	["cat --file=~/.netrc", false],
	["cat /home/dev/proj-other/a.txt", false],
	["cat /HOME/dev/proj/src/main.ts", false],
	["cd src & cat ../../secret.txt", false],
	["cd src\ncat ../../secret.txt", false],
	["cat src/main.ts", true],
	["cat /home/dev/proj/src/main.ts", true],
	["cat ~/proj/src/main.ts", true],
	["cd src && cat ../README.md", true],
	["cat my\\ notes.txt", true],
	["cat C:\\Users\\dev\\secret.txt", true],
	["echo $PATH", true],
	["awk '{print $1}' src/data.csv", true],
	["git status", true],
];

describe("checkCommandBoundary on win32", () => {
	for (const [command, allowed] of WIN32_COMMANDS) {
		test(`${allowed ? "allows" : "denies"} ${JSON.stringify(command)}`, () => {
			expect(checkCommandBoundary(command, WIN_WS, [], WIN_HOST).allowed).toBe(allowed);
		});
	}
});

describe("checkCommandBoundary on posix", () => {
	for (const [command, allowed] of POSIX_COMMANDS) {
		test(`${allowed ? "allows" : "denies"} ${JSON.stringify(command)}`, () => {
			expect(checkCommandBoundary(command, POSIX_WS, [], POSIX_HOST).allowed).toBe(allowed);
		});
	}
});

describe("checkCommandBoundary reports what it resolved on win32", () => {
	test("an expanded home path is reported against the real profile directory", () => {
		const result = checkCommandBoundary("type %USERPROFILE%\\.ssh\\id_rsa", WIN_WS, [], WIN_HOST);
		expect(result.violations.map((v) => v.resolved)).toEqual(["C:\\Users\\dev\\.ssh\\id_rsa"]);
	});

	test("an allowed prefix matches regardless of drive-letter case and separator", () => {
		const result = checkCommandBoundary("type c:/windows/system32/drivers/etc/hosts", WIN_WS, ["C:\\Windows\\System32"], WIN_HOST);
		expect(result.allowed).toBe(true);
	});
});

describe("checkFilePathBoundary on win32", () => {
	const rows: Row[] = [
		["C:\\Users\\dev\\secret.txt", false],
		["..\\secret.txt", false],
		["D:\\proj\\a.txt", false],
		["\\\\server\\share\\a.txt", false],
		["src\\main.ts", true],
		["C:\\USERS\\dev\\proj\\src\\main.ts", true],
		["\\\\?\\C:\\Users\\dev\\proj\\src\\main.ts", true],
	];
	for (const [p, allowed] of rows) {
		test(`${allowed ? "allows" : "denies"} ${JSON.stringify(p)}`, () => {
			expect(checkFilePathBoundary(p, WIN_WS, [], WIN_HOST).allowed).toBe(allowed);
		});
	}
});

describe("validatePath on win32", () => {
	const home = "C:\\Users\\dev";
	const rows: [string, string | null][] = [
		["C:\\Users\\dev\\.ssh\\id_rsa", "protected credential file"],
		["C:\\Users\\DEV\\.SSH\\id_rsa", "protected credential file"],
		["c:/users/dev/.aws/credentials", "protected credential file"],
		["C:\\Users\\dev\\proj\\ID_RSA", "protected credential file"],
		["C:\\Users\\dev\\proj\\NUL", "device file"],
		["\\\\?\\C:\\Users\\dev\\.ssh\\id_rsa", "UNC path not allowed"],
		["C:\\Users\\dev\\proj\\src\\main.ts", null],
	];
	for (const [p, reason] of rows) {
		test(`${reason ?? "accepts"}: ${JSON.stringify(p)}`, () => {
			const r = validatePath(p, WIN_WS, { platform: "win32", home });
			expect(r.ok ? null : r.reason).toBe(reason);
		});
	}
});

// Real filesystem, real platform: only meaningful on a Windows host, where
// realpath, drive letters and 8.3 temp names are the genuine article.
describe.if(process.platform === "win32")("workspace boundary on a real Windows filesystem", () => {
	const ws = fs.mkdtempSync(path.join(os.tmpdir(), "wb-win-"));
	const outside = fs.mkdtempSync(path.join(os.tmpdir(), "wb-win-out-"));
	fs.mkdirSync(path.join(ws, "src"));
	fs.writeFileSync(path.join(ws, "src", "main.ts"), "export {}");
	fs.writeFileSync(path.join(outside, "secret.txt"), "secret");
	afterAll(() => {
		fs.rmSync(ws, { recursive: true, force: true });
		fs.rmSync(outside, { recursive: true, force: true });
	});

	const rows: [() => string, boolean][] = [
		[() => `type ${path.join(ws, "src", "main.ts")}`, true],
		[() => `type ${path.join(ws, "src", "main.ts").toUpperCase()}`, true],
		[() => `type ${path.join(ws, "src", "main.ts").replace(/\\/g, "/")}`, true],
		[() => `type \\\\?\\${path.join(ws, "src", "main.ts")}`, false],
		[() => "type src\\main.ts", true],
		[() => `type ${path.join(outside, "secret.txt")}`, false],
		[() => `type ${path.basename(ws)}\\..\\..\\${path.basename(outside)}\\secret.txt`, false],
		[() => `type ..\\${path.basename(outside)}\\secret.txt`, false],
		[() => "type %USERPROFILE%\\.ssh\\id_rsa", false],
		[() => "type ~\\.ssh\\id_rsa", false],
		[() => `cd src & type ..\\..\\${path.basename(outside)}\\secret.txt`, false],
	];
	for (const [command, allowed] of rows) {
		test(`${allowed ? "allows" : "denies"} ${command()}`, () => {
			expect(checkCommandBoundary(command(), ws).allowed).toBe(allowed);
		});
	}

	test("validatePath rejects the real profile's .SSH directory in any case", () => {
		const r = validatePath(path.join(os.homedir(), ".SSH", "id_rsa"), ws);
		expect(r.ok ? null : r.reason).toBe("protected credential file");
	});
});
