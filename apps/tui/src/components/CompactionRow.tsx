/**
 * The compaction row (#4958): "Compacted from 41k to 9k tokens", with the
 * summary one tap away. Collapsed it is two lines; a tap (or /compact show)
 * opens the summary in place and a second tap folds it. The whole row is the
 * tap target, as tall as it is drawn.
 */

import { Box, Text } from "ink";
import React, { useRef } from "react";
import { useClickSpans, usePressedIn } from "../lib/click-targets.js";
import { type CompactionNote, compactionLines } from "../lib/compaction-view.js";
import { glyphs } from "../lib/term-caps.js";
import { t } from "../theme.js";

export function CompactionRow({
	id,
	note,
	width,
	onToggle,
}: {
	id: string;
	note: CompactionNote;
	width: number;
	onToggle?: (id: string) => void;
}) {
	const ref = useRef(null);
	const lines = compactionLines(note, width);
	useClickSpans(ref, [
		{ id: `compaction:${id}`, dx: 0, w: width, h: lines.length, action: () => onToggle?.(id) },
	]);
	const pressed = usePressedIn("compaction:") === `compaction:${id}`;
	const ascii = glyphs().rule === "-";
	const marker = note.expanded ? (ascii ? "v" : "▾") : ascii ? ">" : "▸";
	return (
		<Box ref={ref} flexDirection="column" marginBottom={1} width={width}>
			{lines.map((l, i) => (
				<Text
					key={i}
					wrap="truncate-end"
					color={
						l.kind === "head" ? t.textPrimary : l.kind === "hint" ? t.textTertiary : t.textSecondary
					}
					bold={l.kind === "head"}
					inverse={pressed && i === 0}
				>
					{i === 0 ? `${marker} ${l.text}` : `  ${l.text}`}
				</Text>
			))}
		</Box>
	);
}
