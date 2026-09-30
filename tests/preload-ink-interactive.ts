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
