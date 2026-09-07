/**
 * Test preload: give the whole `bun test` process a throwaway home directory.
 *
 * packages/settings and apps/tui/src/hooks/useWorkspaceTabs resolve
 * ~/.8gent/... from os.homedir() at module load, and Bun's os.homedir() does
 * not follow a runtime change to process.env.HOME. A per-file mock cannot fix
 * that once an earlier test file has imported those modules, which is how the
 * App-level tests ended up reading and writing the developer's real
 * ~/.8gent/settings.json and ~/.8gent/tabs/state.json. Preloads run before
 * any test file, so the redirect below is in place for every import.
 *
 * Wired in bunfig.toml under [test] preload.
 */
import { mkdtempSync } from "node:fs";
import * as realOs from "node:os";
import { join } from "node:path";
import { mock } from "bun:test";

const testHome = mkdtempSync(join(realOs.tmpdir(), "8gent-test-home-"));
process.env.HOME = testHome;
process.env.EIGHT_TEST_HOME = testHome;

const patched = { ...realOs, homedir: () => testHome };
mock.module("node:os", () => ({ ...patched, default: patched }));
mock.module("os", () => ({ ...patched, default: patched }));
