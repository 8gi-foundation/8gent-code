/**
 * The output block under a trail or result row (#4954), and the tap on it.
 *
 *   ✗ Ran  bun test packages/decide  exit 1
 *     │ 1 fail  packages/decide/score.test.ts
 *     │ expected 3 received 2   (tie-break)
 *     │ at score.test.ts:41
 *     └ 38 more lines (^O or tap, /out 3)
 *
 * What the block shows comes from lib/tool-output.ts and which calls are open from
 * lib/tool-output-state.ts, so Ctrl+O, a tap and /out all act on one thing. A row with no output
 * draws exactly what it drew before. Lines are pre-cut to the width: nothing wraps.
 */

import { Box, Text } from "ink";
import { type ReactNode, useRef } from "react";
import { useClickSpans } from "../lib/click-targets.js";
import {
	type OutputRow,
	outputClickSpans,
	rowOutput,
	useToolOutputVersion,
} from "../lib/tool-output-state.js";
import { t } from "../theme.js";

export function OutputRowShell({
	row,
	width,
	children,
}: {
	row: OutputRow;
	width: number;
	children: ReactNode;
}) {
	// Re-draw when any call opens or closes.
	useToolOutputVersion();
	const ref = useRef(null);
	useClickSpans(ref, outputClickSpans(row, width));
	const { view } = rowOutput(row, width);
	if (view.lines.length === 0 && !view.hint) return <>{children}</>;
	return (
		<Box ref={ref} flexDirection="column" flexShrink={0} width={width}>
			{children}
			{view.lines.map((line, i) => (
				// Lines are positional within one block and never reorder.
				// react-doctor-disable-next-line react-doctor/no-array-index-as-key
				<Box key={i} width={width} height={1}>
					<Text color={t.muted} wrap="truncate-end">{`  │ ${line}`}</Text>
				</Box>
			))}
			{view.hint ? (
				<Box width={width} height={1}>
					<Text color={t.textSecondary} wrap="truncate-end">{`  └ ${view.hint}`}</Text>
				</Box>
			) : null}
		</Box>
	);
}
