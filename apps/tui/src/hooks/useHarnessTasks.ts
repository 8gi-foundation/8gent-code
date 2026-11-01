/**
 * useHarnessTasks - live orchestrator rows from a meta-harness StatusEvent
 * source (part of #2797).
 *
 * The source is the structural subset of packages/harness HarnessRunner
 * that the pane needs (allEvents + subscribe), so the in-process wiring is
 * simply `useHarnessTasks(getHarnessRunner())`. Any future remote source
 * (e.g. an SSE client for GET /harness/tasks) only has to expose the same
 * two methods.
 *
 * Ordering safety: we subscribe BEFORE replaying the buffered history.
 * Both calls happen synchronously inside the effect, so no event can slip
 * between them; an event that lands in both replay and live feed is safe
 * because foldStatusEvent is idempotent per event (rows keyed by agentId).
 */

import { useEffect, useState } from "react";
import type { StatusEvent } from "../../../../packages/harness/index";
import { type OrchestratorRow, foldStatusEvent, foldStatusEvents } from "../lib/orchestrator-model";

export interface StatusEventSource {
	/** Buffered StatusEvent history across retained tasks, oldest first. */
	allEvents(): StatusEvent[];
	/** Live feed. Returns an unsubscribe function. */
	subscribe(listener: (event: StatusEvent) => void): () => void;
}

export function useHarnessTasks(source?: StatusEventSource | null): OrchestratorRow[] {
	const [rows, setRows] = useState<OrchestratorRow[]>([]);

	useEffect(() => {
		if (!source) {
			setRows([]);
			return;
		}
		const unsubscribe = source.subscribe((event) => {
			setRows((prev) => foldStatusEvent(prev, event));
		});
		setRows(foldStatusEvents(source.allEvents()));
		return unsubscribe;
	}, [source]);

	return rows;
}
