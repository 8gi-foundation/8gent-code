/**
 * The launch splash must never hold startup (#4662).
 *
 * The splash has its own auto-advance timer, but that timer is armed by an
 * effect inside the splash. On a slow first launch (Termux, Node 26) the
 * splash's mount and the terminal's stdin readiness can both stall, so the
 * timer never starts and no key is read either. This watchdog is armed by the
 * app shell itself, outside the splash, so it fires whatever the splash does.
 *
 * Every phase is written to the boot trace (~/.8gent/logs/tui-boot.log).
 */

import { useEffect } from "react";
import { bootTrace } from "./boot-trace.js";

/** Real-time ceiling on the splash. Under the 5 s a launch is allowed to take. */
export const INTRO_HARD_TIMEOUT_MS = 4500;

export type IntroTrace = (stage: string, detail?: string) => void;

/**
 * Arm the watchdog. `onExpire` runs once if `cancel` was not called first.
 * Returns `cancel`, which is safe to call more than once.
 */
export function armIntroWatchdog(
	onExpire: () => void,
	ms: number = INTRO_HARD_TIMEOUT_MS,
	trace: IntroTrace = bootTrace,
): () => void {
	trace("intro-watchdog-armed", `${ms}ms`);
	let live = true;
	const timer = setTimeout(() => {
		if (!live) return;
		live = false;
		trace("intro-watchdog-fired", `${ms}ms, advancing to the main screen`);
		onExpire();
	}, ms);
	return () => {
		if (!live) return;
		live = false;
		clearTimeout(timer);
		trace("intro-watchdog-cleared");
	};
}

/** While `visible`, force `onExpire` after the hard timeout. */
export function useIntroWatchdog(
	visible: boolean,
	onExpire: () => void,
	ms: number = INTRO_HARD_TIMEOUT_MS,
	trace: IntroTrace = bootTrace,
): void {
	useEffect(() => {
		if (!visible) return;
		return armIntroWatchdog(onExpire, ms, trace);
	}, [visible]);
}
