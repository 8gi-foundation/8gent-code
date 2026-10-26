/**
 * The folded status row (#5170): one line in place of the per-step rows while a
 * turn runs.
 *
 *   ▸ Working: reading files (step 3, 12s)
 *
 * The row is a disclosure. Enter (empty input) or a tap opens the full step
 * list under it, drawn exactly as before; Esc, Enter or a second tap folds it.
 * The text is rebuilt from the latest call at most twice a second and edits in
 * place. The words come from lib/folded-trace.ts: a verb phrase by tool kind,
 * never a path.
 */

import { Box, Text } from "ink";
import { useEffect, useRef, useState } from "react";
import { useClickSpans, usePressedIn } from "../lib/click-targets.js";
import { STATUS_REFRESH_MS, foldedRow, statusStep, statusTool } from "../lib/folded-trace.js";
import { glyphs } from "../lib/term-caps.js";
import type { ToolTrailEntry } from "../lib/tool-trail.js";
import { t } from "../theme.js";

export interface FoldedStatusProps {
	trail: ToolTrailEntry[];
	/** The call running now, if any (the app's activeTool). */
	liveTool?: string | null;
	/** When the turn began (ms since epoch). */
	startedAt: number;
	open: boolean;
	width: number;
	onToggle?: () => void;
	/** Clock for tests. */
	now?: () => number;
}

export function FoldedStatus({
	trail,
	liveTool,
	startedAt,
	open,
	width,
	onToggle,
	now = Date.now,
}: FoldedStatusProps) {
	const ref = useRef(null);
	const ascii = glyphs().rule === "-";
	const marker = open ? (ascii ? "v" : "▾") : ascii ? ">" : "▸";
	const build = () =>
		foldedRow({
			marker,
			open,
			tool: statusTool(liveTool, trail),
			step: statusStep(liveTool, trail),
			seconds: (now() - startedAt) / 1000,
			width,
		});
	// What the row shows is a snapshot, refreshed on a timer: calls that land
	// faster than the refresh do not make the row flicker. Opening or folding
	// it redraws at once.
	const latest = useRef(build);
	latest.current = build;
	const [text, setText] = useState(build);
	// biome-ignore lint/correctness/useExhaustiveDependencies: open and width are the triggers
	useEffect(() => setText(latest.current()), [open, width]);
	useEffect(() => {
		const id = setInterval(() => setText(latest.current()), STATUS_REFRESH_MS);
		return () => clearInterval(id);
	}, []);

	useClickSpans(ref, [{ id: "trace:status", dx: 0, w: width, h: 1, action: () => onToggle?.() }]);
	const pressed = usePressedIn("trace:") === "trace:status";
	return (
		<Box ref={ref} width={width} height={1} flexShrink={0}>
			<Text color={t.textPrimary} wrap="truncate-end" inverse={pressed}>
				{text}
			</Text>
		</Box>
	);
}
