/**
 * Test preload (bunfig.toml [test].preload): the test process never runs
 * against the real home directory (#3240).
 *
 * Tests wrote to the operator's live ~/.8gent: telegram-observe.test.ts
 * appended to and then DELETED ~/.8gent/telegram-observed.jsonl (group
 * history Telegram cannot give back), the huddle tests left huddle folders,
 * the MoA tests trained the real router bandit, and the Table tests appended
 * to the real ToolG8 audit log. So $HOME, EIGHT_HOME and EIGHT_DATA_DIR point at a fresh
 * temp directory for the whole run, removed after it.
 *
 * Bun freezes os.homedir() at process start, so a module that must honour
 * this resolves its path with resolveHome() (packages/core/home.ts); this preload runs before any
 * test module is loaded, so module-level paths resolve here too.
 */
import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const testHome = mkdtempSync(join(tmpdir(), "8gent-test-home-"));
process.env.HOME = testHome;
// resolveHome (packages/core/home.ts) prefers EIGHT_HOME, so pin it too.
process.env.EIGHT_HOME = testHome;
process.env.EIGHT_DATA_DIR = join(testHome, ".8gent");
// A preload-level afterAll runs once, after every test file. process "exit"
// does not fire under bun test, so it cannot do the cleanup.
afterAll(() => {
	rmSync(testHome, { recursive: true, force: true });
});
