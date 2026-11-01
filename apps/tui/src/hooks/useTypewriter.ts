/**
 * useTypewriter — progressively reveal a string, character by character.
 *
 * Used by OnboardingScreen so question prompts feel alive (the agent is
 * "writing" the question in real time) instead of slamming in instantly.
 *
 * Design notes:
 * - When `enabled === false`, the hook returns the full text immediately and
 *   `skip()` is a no-op. This is the right default for tests / CI / non-TTY
 *   stdout / accessibility users who would rather just read the line.
 * - When `fullText` changes, the reveal resets and starts over. This makes
 *   the hook behave correctly across all 15 onboarding steps without the
 *   caller having to remount it manually.
 * - `skip()` jumps to the full text. Wired to Enter/Space in OnboardingScreen
 *   so impatient users can bypass the reveal without waiting.
 * - Cleanup: any pending interval is cleared on unmount and on text change.
 *
 * The reveal algorithm is factored into a pure helper (`computeTypewriterState`
 * + `nextTypewriterCount`) so the smoke harness can validate behaviour without
 * needing React or a renderer. Smoke tests live under the `tui-anim/` category
 * in scripts/smoke.ts.
 */

import { useCallback, useEffect, useRef, useState } from "react";

export interface UseTypewriterOptions {
	/** Milliseconds between each character. Default 30ms (~33 chars/sec). */
	msPerChar?: number;
	/**
	 * If false, the hook returns `{ displayed: fullText, isDone: true }`
	 * immediately and `skip()` is a no-op. Used to disable the effect for
	 * tests, non-TTY stdout, CI, or accessibility-conscious users.
	 */
	enabled?: boolean;
}

export interface UseTypewriterResult {
	displayed: string;
	isDone: boolean;
	skip: () => void;
}

export const DEFAULT_MS_PER_CHAR = 30;

/**
 * Compute how many characters should be revealed after `elapsedMs`. Pure: no
 * React, no timers, no I/O. Used by both the hook (indirectly, via setInterval
 * tick count) and the smoke harness (directly, to validate progression).
 *
 * - When `enabled === false`, returns `fullTextLength` (everything revealed).
 * - Otherwise, returns `floor(elapsedMs / msPerChar)` clamped to fullTextLength.
 */
export function computeTypewriterCount(
	elapsedMs: number,
	fullTextLength: number,
	msPerChar: number,
	enabled: boolean,
): number {
	if (!enabled) return fullTextLength;
	if (fullTextLength <= 0) return 0;
	const ms = Math.max(0, msPerChar);
	if (ms === 0) return fullTextLength;
	const ticks = Math.floor(elapsedMs / ms);
	return Math.min(fullTextLength, Math.max(0, ticks));
}

/**
 * Pure derivation of the user-facing result from a count. Lets the smoke
 * harness build the same `{ displayed, isDone }` view the hook returns,
 * without spinning up a React tree.
 */
export function deriveTypewriterView(
	fullText: string,
	count: number,
	enabled: boolean,
): { displayed: string; isDone: boolean } {
	if (!enabled) return { displayed: fullText, isDone: true };
	const clamped = Math.min(fullText.length, Math.max(0, count));
	const displayed = fullText.slice(0, clamped);
	return { displayed, isDone: displayed.length >= fullText.length };
}

export function useTypewriter(
	fullText: string,
	options?: UseTypewriterOptions,
): UseTypewriterResult {
	const msPerChar = options?.msPerChar ?? DEFAULT_MS_PER_CHAR;
	const enabled = options?.enabled !== false;

	// When disabled, render the full text in one go. The hooks below still
	// run (rules of hooks) but their state never advances past initial.
	const [count, setCount] = useState<number>(enabled ? 0 : fullText.length);
	const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
	const fullTextRef = useRef<string>(fullText);
	// Keep the latest target length in a ref so the interval callback always
	// stops at the right place, even if the text mutates mid-reveal.
	const targetLengthRef = useRef<number>(fullText.length);

	const clearTick = useCallback(() => {
		if (intervalRef.current) {
			clearInterval(intervalRef.current);
			intervalRef.current = null;
		}
	}, []);

	const startTick = useCallback(() => {
		clearTick();
		intervalRef.current = setInterval(() => {
			setCount((prev) => {
				if (prev >= targetLengthRef.current) {
					clearTick();
					return prev;
				}
				return prev + 1;
			});
		}, Math.max(1, msPerChar));
	}, [msPerChar, clearTick]);

	// On mount + whenever fullText changes: reset and (re)start the reveal.
	// Depending only on fullText/enabled keeps this from looping on `count`.
	useEffect(() => {
		fullTextRef.current = fullText;
		targetLengthRef.current = fullText.length;
		if (!enabled) {
			clearTick();
			setCount(fullText.length);
			return;
		}
		setCount(0);
		if (fullText.length === 0) return;
		startTick();
		return clearTick;
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [fullText, enabled]);

	// Cleanup on unmount.
	useEffect(() => clearTick, [clearTick]);

	const skip = useCallback(() => {
		if (!enabled) return;
		clearTick();
		setCount(fullTextRef.current.length);
	}, [enabled, clearTick]);

	const view = deriveTypewriterView(fullText, count, enabled);
	return { displayed: view.displayed, isDone: view.isDone, skip };
}
