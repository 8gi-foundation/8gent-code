/**
 * AgentInstrumentStrip — bordered card row of named cells.
 *
 * Each cell is a `StatusCard`: muted uppercase label on top, brighter
 * value below. Cards size via `flexGrow={1} flexBasis={0}` so terminal
 * width divides evenly; `wrap="truncate-end"` on every value prevents
 * the one-char-per-line collapse Ink produces when a row child gets
 * starved.
 *
 * Card-specific deviations:
 *   AGENTS — value is a row of LED dots + "n/n" so the indicator reads
 *            at a glance. TOKENS — meter glyph row left, count right
 *            (justifyContent="space-between") per design feedback.
 */

import { Box, Text } from "ink";
import React from "react";
import { theme } from "../theme.js";

const ui = {
	cardBorder: theme.color.cardBorder,
	muted: theme.color.muted,
	dim: theme.color.dim,
	teal: theme.color.teal,
	steel: theme.color.steel,
	orange: theme.color.orange,
	cream: theme.color.cream,
	red: theme.color.red,
} as const;

export interface AgentInstrumentStripProps {
	model: string;
	ready: number;
	total: number;
	tokens: string;
	branch: string;
	agent: string;
	micOn: boolean;
	permissions: string;
	sessionTime: string;
}

export function AgentInstrumentStrip({
	model,
	ready,
	total,
	tokens,
	branch,
	agent,
	micOn,
	permissions,
	sessionTime,
}: AgentInstrumentStripProps) {
	return (
		<Box width="100%" flexShrink={0} gap={1} overflow="hidden">
			<StatusCard label="Model" value={model} color={ui.cream} />

			<StatusCard label="Agents">
				<Box>
					{Array.from({ length: Math.max(total, 1) }).map((_, i) => (
						<Text key={i} color={i < ready ? ui.teal : ui.dim}>
							●
						</Text>
					))}
					<Text color={ui.teal}>
						{" "}
						{ready}/{total}
					</Text>
				</Box>
			</StatusCard>

			<StatusCard label="Tokens">
				<Box justifyContent="space-between">
					<Text color={ui.steel}>▁▂▃▄▅▆</Text>
					<Text color={ui.steel} wrap="truncate-end">
						{tokens}
					</Text>
				</Box>
			</StatusCard>

			<StatusCard label="Branch" value={branch} color={ui.orange} />
			<StatusCard label="Agent" value={agent} color={ui.cream} />
			<StatusCard
				label="Mic"
				value={micOn ? "on" : "off"}
				color={micOn ? ui.teal : ui.muted}
			/>
			<StatusCard
				label="Approval"
				value={permissions === "ask" ? "?" : permissions}
				color={permissions === "ask" ? ui.red : ui.cream}
			/>
			<StatusCard label="Session" value={sessionTime} color={ui.muted} />
		</Box>
	);
}

interface StatusCardProps {
	label: string;
	/** Convenience prop for simple label+value cards. Use `children` for
	 *  cards that need their own inner layout (LEDs, meter rows, etc.). */
	value?: string;
	color?: string;
	children?: React.ReactNode;
}

function StatusCard({ label, value, color = ui.cream, children }: StatusCardProps) {
	return (
		<Box
			flexGrow={1}
			flexBasis={0}
			flexShrink={1}
			minWidth={0}
			borderStyle="round"
			borderColor={ui.cardBorder}
			paddingX={1}
			flexDirection="column"
			overflow="hidden"
		>
			<Text color={ui.muted} wrap="truncate-end" bold>
				{label.toUpperCase()}
			</Text>
			{children ? (
				children
			) : (
				<Text color={color} wrap="truncate-end">
					{value ?? ""}
				</Text>
			)}
		</Box>
	);
}
