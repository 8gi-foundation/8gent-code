import { describe, expect, test } from "bun:test";
import {
	mkdtempSync,
	readFileSync,
	readdirSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readKeysFile, setKeyInFile } from "./keys";

const GOOD = "fake-key-0123456789abcd";

describe("setKeyInFile", () => {
	const f = () => join(mkdtempSync(join(tmpdir(), "keys-")), "keys.env");
	test("rejects a short value and writes nothing", () => {
		const p = f();
		expect(setKeyInFile("MINIMAX_API_KEY", "Z", p)).toContain("too short");
		expect(() => readFileSync(p)).toThrow();
	});
	test("writes 0600, replaces an earlier line, keeps others", () => {
		const p = f();
		writeFileSync(p, "OTHER=keepme\nMINIMAX_API_KEY=Z\n", { mode: 0o644 });
		expect(setKeyInFile("MINIMAX_API_KEY", GOOD, p)).toBeNull();
		expect(readFileSync(p, "utf-8")).toBe(`OTHER=keepme\nMINIMAX_API_KEY=${GOOD}\n`);
		expect(statSync(p).mode & 0o777).toBe(0o600);
	});
	test("a fresh file is created 0600 and no temp file is left behind", () => {
		const p = f();
		expect(setKeyInFile("MINIMAX_API_KEY", GOOD, p)).toBeNull();
		expect(statSync(p).mode & 0o777).toBe(0o600);
		expect(readdirSync(join(p, ".."))).toEqual(["keys.env"]);
	});

	// 8SO #4681: a pasted value must not be able to add a second env line.
	test.each([
		["line feed", `${GOOD}\nEIGHT_SHELL_ENV_X=1`],
		["carriage return", `${GOOD}\rMINIMAX_BASE_URL=https://evil.example`],
		["inner space", `${GOOD} OTHER=1`],
		["escape byte", `\u001b[200~${GOOD}`],
		["unicode line separator", `${GOOD} OPENAI_BASE_URL=https://evil.example`],
		["shell expansion", `${GOOD}$(touch /tmp/pwn)`],
		["backtick", `${GOOD}\`id\``],
		["quote", `"${GOOD}`],
		["backslash", `${GOOD}\\`],
	])("rejects a value with a %s and writes nothing", (_label, value) => {
		const p = f();
		writeFileSync(p, "OTHER=keepme\n", { mode: 0o600 });
		const err = setKeyInFile("MINIMAX_API_KEY", value, p);
		expect(err).toContain("Nothing was saved");
		expect(err).not.toContain(GOOD);
		expect(readFileSync(p, "utf-8")).toBe("OTHER=keepme\n");
		expect(Object.keys(readKeysFile(p))).toEqual(["OTHER"]);
	});

	test("an = inside the value stays in the value, not a new variable", () => {
		const p = f();
		expect(setKeyInFile("MINIMAX_API_KEY", `${GOOD}==`, p)).toBeNull();
		expect(readKeysFile(p)).toEqual({ MINIMAX_API_KEY: `${GOOD}==` });
	});

	// 8SO #4681: the name comes from a provider's apiKeyEnv, which providers.json can set.
	test.each([
		"MINIMAX_BASE_URL",
		"PATH",
		"NODE_OPTIONS",
		"EIGHT_SHELL_ENV_X",
		"EIGHT_DATA_DIR",
		"EIGHT_TG_TOKEN",
		"minimax_api_key",
		"A=B_API_KEY",
		"X_API_KEY\nPATH",
	])("refuses to write the non-credential name %p", (name) => {
		const p = f();
		expect(setKeyInFile(name, GOOD, p)).toContain("not a key name");
		expect(() => readFileSync(p)).toThrow();
	});

	test("refuses to follow a symlink at the keys path", () => {
		const dir = mkdtempSync(join(tmpdir(), "keys-"));
		const victim = join(dir, "victim.txt");
		writeFileSync(victim, "do not touch\n");
		const p = join(dir, "keys.env");
		symlinkSync(victim, p);
		expect(setKeyInFile("MINIMAX_API_KEY", GOOD, p)).toContain("link");
		expect(readFileSync(victim, "utf-8")).toBe("do not touch\n");
	});
});
