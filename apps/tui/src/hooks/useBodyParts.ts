/**
 * useBodyParts - in-memory session state for the body-parts visual indicators.
 *
 * Three capabilities surfaced on the right rail (ActivityRail):
 *   hands     - cliclick-driven cursor and keyboard control
 *   eyes      - AX-bridge driven screen reads (no peekaboo)
 *   handeyes  - engagement loop that drives hands from what eyes see
 *
 * Each part has three visible states (mirrors the rail's tool glyphs):
 *   disabled - capability is off for this session (also the fallback when the
 *              underlying binary is missing)
 *   idle     - capability is enabled and not currently doing anything
 *   inFlight - a tool call belonging to this part is running right now
 *
 * Defaults on first render:
 *   hands     enabled if `cliclick` is on PATH
 *   eyes      enabled if ~/.8gent/bin/8gent-ax-bridge exists
 *   handeyes  enabled if BOTH of the above are true
 *
 * Visual oracle only. v1 does NOT gate the underlying tools when disabled;
 * the indicators just reflect intent. State is in-memory, scoped to the TUI
 * session, and resets on every restart by design. No persistence.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

export type BodyPart = "hands" | "eyes" | "handeyes";
export type BodyPartState = "disabled" | "idle" | "inFlight";

export interface BodyPartsState {
	hands: BodyPartState;
	eyes: BodyPartState;
	handeyes: BodyPartState;
}

const PULSE_FLASH_MS = 150;

function hasCliclick(): boolean {
	try {
		execSync("command -v cliclick", { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

function hasAxBridge(): boolean {
	return existsSync(join(homedir(), ".8gent", "bin", "8gent-ax-bridge"));
}

/**
 * Detect default enabled state on first render. Exported so tests can verify
 * the contract independently of the hook lifecycle.
 */
export function detectDefaultBodyPartsState(): BodyPartsState {
	const handsOk = hasCliclick();
	const eyesOk = hasAxBridge();
	return {
		hands: handsOk ? "idle" : "disabled",
		eyes: eyesOk ? "idle" : "disabled",
		handeyes: handsOk && eyesOk ? "idle" : "disabled",
	};
}

/**
 * Map a raw tool name (e.g. "desktop_click", "eyes_read", "handeyes_loop") to
 * the body part it belongs to, or null if the tool is unrelated. Centralised
 * so the rail wiring and any other observer share one prefix table.
 */
export function bodyPartForToolName(toolName: string | null | undefined): BodyPart | null {
	if (!toolName) return null;
	if (toolName.startsWith("desktop_")) return "hands";
	if (toolName.startsWith("eyes_")) return "eyes";
	if (toolName.startsWith("handeyes_")) return "handeyes";
	return null;
}

export interface UseBodyPartsApi {
	state: BodyPartsState;
	/** Toggle a part between idle and disabled. No effect on inFlight. */
	toggle: (part: BodyPart) => BodyPartState;
	/** Mark a tool call as starting. Flips the matching part to inFlight. */
	markStart: (toolName: string) => void;
	/** Mark a tool call as ending. Brief flash, then back to bright idle. */
	markEnd: (toolName: string) => void;
}

/**
 * Session-scoped state hook. In-memory only, resets each TUI launch.
 */
export function useBodyParts(): UseBodyPartsApi {
	const [state, setState] = useState<BodyPartsState>(() => detectDefaultBodyPartsState());

	// Track whether the user has explicitly disabled a part this session so a
	// tool call cannot silently re-enable it. Disabled means disabled.
	const userDisabledRef = useRef<Record<BodyPart, boolean>>({
		hands: false,
		eyes: false,
		handeyes: false,
	});

	const toggle = useCallback((part: BodyPart): BodyPartState => {
		let next: BodyPartState = "disabled";
		setState((cur) => {
			const prev = cur[part];
			if (prev === "inFlight") {
				next = prev;
				return cur;
			}
			next = prev === "disabled" ? "idle" : "disabled";
			userDisabledRef.current[part] = next === "disabled";
			return { ...cur, [part]: next };
		});
		return next;
	}, []);

	const markStart = useCallback((toolName: string) => {
		const part = bodyPartForToolName(toolName);
		if (!part) return;
		if (userDisabledRef.current[part]) return;
		setState((cur) => (cur[part] === "inFlight" ? cur : { ...cur, [part]: "inFlight" }));
	}, []);

	const markEnd = useCallback((toolName: string) => {
		const part = bodyPartForToolName(toolName);
		if (!part) return;
		// Brief flash window before falling back to idle. A trailing setTimeout
		// is the simplest single observable state - no double-pulse race, no
		// reentrancy because subsequent starts overwrite inFlight again.
		setTimeout(() => {
			setState((cur) => {
				if (cur[part] !== "inFlight") return cur;
				return { ...cur, [part]: userDisabledRef.current[part] ? "disabled" : "idle" };
			});
		}, PULSE_FLASH_MS);
	}, []);

	// Safety net: if the TUI unmounts mid-pulse the timer is already cleared
	// by node teardown. Nothing else to clean up.
	useEffect(() => undefined, []);

	return { state, toggle, markStart, markEnd };
}
