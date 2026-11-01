/**
 * The permission-mode toast (#3174): one line in the footer hints slot after
 * a switch, for 3 s (Infinite 5 s), then gone.
 *
 * One timer per toast, cleared when it fires, when a newer toast replaces it
 * and on unmount. Nothing animates and nothing runs while no toast is up, so
 * an idle HUD costs no CPU. The toast belongs to the tab it was raised on:
 * switching tabs hides it (the new tab's own segment tells its truth).
 */

import { useCallback, useEffect, useState } from "react";
import type { PermissionMode } from "../../../../packages/permissions/permission-mode.js";
import { permToastMs } from "../lib/perm-modes-design.js";

export interface PermToast {
	tabId: string;
	mode: PermissionMode;
	held: boolean;
}

export function usePermToast(
	activeTabId: string,
	msFor: (mode: PermissionMode) => number = permToastMs,
): [PermToast | null, (toast: PermToast) => void] {
	const [toast, setToast] = useState<PermToast | null>(null);
	useEffect(() => {
		if (!toast) return;
		const id = setTimeout(() => setToast((cur) => (cur === toast ? null : cur)), msFor(toast.mode));
		return () => clearTimeout(id);
	}, [toast, msFor]);
	// A fresh object each time, so a second switch to the same mode restarts the clock.
	const show = useCallback((next: PermToast) => setToast({ ...next }), []);
	return [toast && toast.tabId === activeTabId ? toast : null, show];
}
