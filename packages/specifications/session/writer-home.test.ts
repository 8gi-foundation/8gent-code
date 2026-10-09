import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionWriter } from "./writer.js";

const realHome = process.env.HOME;
let tmp: string | undefined;

afterEach(() => {
	process.env.HOME = realHome;
	if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
	tmp = undefined;
});

describe("SessionWriter default directory (#3678)", () => {
	test("writes only under the runtime HOME, not the module-load homedir", () => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sw-home-"));
		process.env.HOME = tmp;
		const id = `home-test-${Date.now()}`;
		const w = new SessionWriter(id);
		const expected = path.join(tmp, ".8gent", "sessions", `${id}.jsonl`);
		expect(fs.existsSync(expected)).toBe(true);
		if (realHome && realHome !== tmp) {
			expect(fs.existsSync(path.join(realHome, ".8gent", "sessions", `${id}.jsonl`))).toBe(false);
		}
		void w;
	});
});
