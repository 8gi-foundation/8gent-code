/**
 * Subscribe a component to the Control store (#5062). With `enabled` false the
 * hook does nothing: no read, no watcher. The store reads on the first
 * subscriber and closes its watchers on the last unsubscribe.
 */
import { useEffect, useState } from "react";
import { type ControlSnapshot, controlStore } from "../lib/control-store.js";

export function useControlSnapshot(
	enabled: boolean,
	opts: { header?: boolean } = {},
): ControlSnapshot | null {
	const [snap, setSnap] = useState<ControlSnapshot | null>(null);
	useEffect(() => {
		if (!enabled) {
			setSnap(null);
			return;
		}
		const off = controlStore.subscribe(() => setSnap(controlStore.get()), { header: opts.header });
		// A second subscriber joins a store that already holds a snapshot.
		setSnap(controlStore.get());
		return off;
	}, [enabled, opts.header]);
	return snap;
}
