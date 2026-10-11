import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openInExternalEditor, resolveEditorCommand, splitCommand } from "./external-editor.js";

const dir = mkdtempSync(join(tmpdir(), "ed-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function fakeEditor(name: string, body: string): string {
	const p = join(dir, name);
	writeFileSync(p, `#!/bin/sh\n${body}\n`);
	chmodSync(p, 0o755);
	return p;
}
const tmpEdits = () => readdirSync(tmpdir()).filter((f) => f.startsWith("8gent-edit-"));

describe("splitCommand", () => {
	test("splits flags and honors quotes", () => {
		expect(splitCommand("code --wait")).toEqual(["code", "--wait"]);
		expect(splitCommand(`"/Program Files/x/ed" -w 'a b'`)).toEqual(["/Program Files/x/ed", "-w", "a b"]);
		expect(splitCommand("   ")).toEqual([]);
	});
});

describe("resolveEditorCommand", () => {
	test("VISUAL beats EDITOR, then platform fallback", () => {
		expect(resolveEditorCommand({ VISUAL: "code --wait", EDITOR: "nano" }, "linux")).toEqual(["code", "--wait"]);
		expect(resolveEditorCommand({ EDITOR: "nano" }, "linux")).toEqual(["nano"]);
		expect(resolveEditorCommand({}, "linux")).toEqual(["vi"]);
		expect(resolveEditorCommand({}, "win32")).toEqual(["notepad"]);
		expect(resolveEditorCommand({ VISUAL: "  " }, "darwin")).toEqual(["vi"]);
	});
});

describe("openInExternalEditor", () => {
	test("returns the edited text, passes flags, and removes the temp file", () => {
		const before = tmpEdits().length;
		const ed = fakeEditor("ed1", 'f="$2"; [ "$1" = "--wait" ] || exit 9; printf "%s EDITED\\n" "$(cat "$f")" > "$f"');
		const out = openInExternalEditor("hello", { env: { ...process.env, VISUAL: `${ed} --wait` } });
		expect(out).toBe("hello EDITED");
		expect(tmpEdits().length).toBe(before);
	});
	test("non-zero exit returns null and still cleans up", () => {
		const before = tmpEdits().length;
		const ed = fakeEditor("ed2", 'printf "changed" > "$1"; exit 1');
		expect(openInExternalEditor("x", { env: { ...process.env, VISUAL: ed } })).toBeNull();
		expect(tmpEdits().length).toBe(before);
	});
	test("missing editor returns null", () => {
		expect(openInExternalEditor("x", { env: { ...process.env, VISUAL: join(dir, "nope") } })).toBeNull();
	});
	test("no shell: metacharacters in the command are not interpreted", () => {
		const marker = join(dir, "pwned");
		const ed = fakeEditor("ed3", "exit 0");
		openInExternalEditor("x", { env: { ...process.env, VISUAL: `${ed} ;touch ${marker}` } });
		expect(existsSync(marker)).toBe(false);
	});
});
