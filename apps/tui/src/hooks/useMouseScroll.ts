/**
 * Mouse wheel scrolling for the chat list.
 *
 * Since #3239 the mouse layer is one module installed at startup
 * (lib/mouse-input.ts): it turns reporting on and off, strips every mouse
 * sequence before Ink reads, and tears down on every exit path. This hook
 * only listens for wheel events. Before, it patched stdin itself and turned
 * reporting on and off with the chat list's mount, and its per-chunk filter
 * leaked the tail of a split sequence into the input.
 */

import { useEffect, useRef } from "react";
import { onMouse } from "../lib/mouse-input.js";

export interface MouseScrollHandlers {
	onWheelUp: () => void;
	onWheelDown: () => void;
	/** When false, the hook is a no-op (user toggled off, or unsupported env). */
	enabled?: boolean;
	/** Lines moved per wheel tick. iTerm/Chrome default = 3. */
	step?: number;
}

export function useMouseScroll({
	onWheelUp,
	onWheelDown,
	enabled = true,
	step = 3,
}: MouseScrollHandlers) {
	// Latest handlers without re-subscribing on every render.
	const upRef = useRef(onWheelUp);
	const downRef = useRef(onWheelDown);
	upRef.current = onWheelUp;
	downRef.current = onWheelDown;

	useEffect(() => {
		if (!enabled) return;
		return onMouse((e) => {
			if (e.kind !== "wheel") return;
			const fn = e.button === 0 ? upRef.current : downRef.current;
			for (let i = 0; i < step; i++) fn();
		});
	}, [enabled, step]);
}
