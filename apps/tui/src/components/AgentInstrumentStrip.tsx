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
 *            at a glance. TOKENS — total count, optionally suffixed with
 *            live tokens-per-second from the last streamed step.
 */

import { Box, Text } from "ink";
import React from "react";
import { theme } from "../theme.js";

function truncateMiddle(value: string, max: number): string {
	if (value.length <= max) return value;
	const keep = max - 1;
	const left = Math.ceil(keep * 0.55);
	const right = Math.floor(keep * 0.45);
	return `${value.slice(0, left)}…${value.slice(value.length - right)}`;
}

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
	/** Optional user override. When omitted, the card reads
	 *  `process.env.USER` / `process.env.LOGNAME` / "Guest". (#2366) */
	user?: string;
	permissions: string;
	sessionTime: string;
	/** Smoothed output tokens-per-second from the most recent agent step.
	 *  Rendered as compact shorthand in the Tokens card (e.g. "61t/s"). */
	tokensPerSecond?: number;
}

/** Format tokens-per-second into a compact 5-7 char string for the cell.
 *  Drops the space before the unit so it stays inside narrow card widths:
 *  "61t/s", "234t/s", "9.8t/s". The Tokens card is the most squeezed
 *  cell in the strip, so every character matters. */
function formatTps(tps: number): string {
	if (tps <= 0) return "";
	if (tps >= 100) return `${Math.round(tps)}t/s`;
	if (tps >= 10) return `${tps.toFixed(0)}t/s`;
	return `${tps.toFixed(1)}t/s`;
}

/** Resolve the bottom-HUD USER label. Env-driven so the card reads as the
 *  human at the keyboard, not the literal string "Guest". (#2366) */
function resolveUser(override?: string): string {
	if (override && override.trim().length > 0) return override;
	const fromEnv = process.env.USER || process.env.LOGNAME;
	return fromEnv && fromEnv.trim().length > 0 ? fromEnv : "Guest";
}

export function AgentInstrumentStrip({
	model,
	ready,
	total,
	tokens,
	branch,
	user,
	permissions,
	sessionTime,
	tokensPerSecond,
}: AgentInstrumentStripProps) {
	const tpsLabel = tokensPerSecond ? formatTps(tokensPerSecond) : "";
	// MIC indicator lives in HeaderBar (single source of truth, top-right
	// one-glance read). Do NOT add it back here. (#2368)
	return (
		<Box width="100%" flexShrink={0} gap={1} overflow="hidden">
			<StatusCard label="Model" value={truncateMiddle(model, 14)} color={ui.cream} />

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
				<Text color={ui.cream} wrap="truncate-end">
					{tpsLabel ? (
						<>
							{tokens.replace(/ tok$/, "")}
							<Text color={ui.steel}> · </Text>
							<Text color={ui.teal}>{tpsLabel}</Text>
						</>
					) : (
						tokens
					)}
				</Text>
			</StatusCard>

			<StatusCard label="Branch" value={branch} color={ui.orange} />
			<StatusCard label="User" value={resolveUser(user)} color={ui.cream} />
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
