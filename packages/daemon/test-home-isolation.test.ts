/**
 * #3240: no daemon test may resolve a path under the real home directory.
 * os.homedir() is frozen at process start, so it still names the real home;
 * every path the tests were found writing must resolve somewhere else.
 */

import { expect, test } from "bun:test";
import { homedir } from "node:os";
import { getAuditPath } from "../permissions/toolg8";
import { defaultBanditStorePath } from "../providers/router-bandit";
import { CREATIVE_DIR, HUDDLES_DIR } from "../table/bake";
import { CREATIVE_DIR as PDF_CREATIVE_DIR } from "../tools/make-pdf";
import { OBSERVED_LOG } from "./telegram-bridge";

const realHome = homedir();
const underRealHome = (p: string) => p === realHome || p.startsWith(`${realHome}/`);

test("the test process runs with a temp $HOME, not the real one", () => {
	expect(process.env.HOME).toBeTruthy();
	expect(underRealHome(process.env.HOME as string)).toBe(false);
});

const paths: Record<string, () => string> = {
	"telegram observed log": () => OBSERVED_LOG,
	"router bandit store": () => defaultBanditStorePath(),
	"huddles dir": () => HUDDLES_DIR,
	"creative dir": () => CREATIVE_DIR,
	"ToolG8 audit log": () => getAuditPath(),
	"make_pdf creative dir": () => PDF_CREATIVE_DIR,
};

for (const [name, path] of Object.entries(paths)) {
	test(`${name} resolves under the temp $HOME, never the real home`, () => {
		expect(underRealHome(path())).toBe(false);
		expect(path().startsWith(process.env.HOME as string)).toBe(true);
	});
}
