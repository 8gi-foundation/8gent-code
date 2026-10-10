/**
 * Test preload (bunfig.toml [test].preload): render Ink interactively under
 * `bun test`, whether or not CI is set.
 *
 * Ink reads the `is-in-ci` package once, at import. When CI (or
 * CONTINUOUS_INTEGRATION) is set it switches to CI mode and writes only the
 * final frame on unmount, so every render test that inspects intermediate
 * frames (CommandInput Enter handling, PlanPanel, the settle motion) sees an
 * empty screen and fails. That is a property of the test process, not of the
 * code under test, so the fix lives here: only Ink's CI detection is pinned
 * to false. process.env.CI is left untouched for every other test.
 */
import { mock } from "bun:test";

mock.module("is-in-ci", () => ({ default: false }));

// The TUI draws ASCII glyphs on the legacy Windows console, detected as win32 with no
// WT_SESSION and no TERM_PROGRAM (apps/tui/src/lib/term-caps.ts). A GitHub Windows runner
// is exactly that, so render tests that assert the rich glyphs (check marks, box rules,
// bullets) saw "+" and "=" there. Declare a modern terminal for the test process; the
// legacy fallback itself stays covered by term-caps.test.ts, which passes its own env.
if (process.platform === "win32" && !process.env.WT_SESSION && !process.env.TERM_PROGRAM) {
	process.env.TERM_PROGRAM = "8gent-test";
}
