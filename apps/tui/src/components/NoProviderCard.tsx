import { Box, Text } from "ink";
import React from "react";
import {
	type GuidanceCopy,
	type GuidanceInput,
	guidanceCopy,
	needsProviderGuidance,
} from "../lib/no-provider-guidance.js";
import { t } from "../theme.js";

/**
 * Theme tokens the card puts text in, by role. Exported so the contrast test
 * checks exactly these against both palettes (AA, 4.5:1). The border uses
 * `frame`, the structural edge token (3:1 or better, non-text).
 */
export const NO_PROVIDER_TONES = {
	label: "orange",
	lead: "prose",
	title: "textPrimary",
	step: "teal",
	number: "heading",
	reason: "textSecondary",
} as const;

/**
 * The first-run "no model" card (T5). Meaning never rests on colour: the
 * state is the word NO MODEL, paths are numbered in text, and commands sit on
 * their own indented lines, so NO_COLOR output reads the same. No blank
 * rows inside: on a first run it shares the chat area with the setup card.
 */
export function NoProviderCard({
	copy = guidanceCopy(),
	reason,
	compact = false,
}: { copy?: GuidanceCopy; reason?: string | null; compact?: boolean }) {
	if (compact) {
		// Short terminal: the lead and one line per path, no reason line (the
		// setup card above already says what could not be reached).
		return (
			<Box
				borderStyle="round"
				borderColor={t.frame}
				paddingX={1}
				flexDirection="column"
				flexShrink={0}
			>
				<Box>
					<Box flexShrink={0} marginRight={1}>
						<Text color={t[NO_PROVIDER_TONES.label]} bold>
							{copy.label}
						</Text>
					</Box>
					<Text color={t[NO_PROVIDER_TONES.lead]}>{copy.lead}</Text>
				</Box>
				{copy.compact.map((line, i) => (
					<Box key={line}>
						<Box flexShrink={0} width={3}>
							<Text color={t[NO_PROVIDER_TONES.number]} bold>
								{copy.paths[i]?.n ?? String(i + 1)}
							</Text>
						</Box>
						<Text color={t[NO_PROVIDER_TONES.step]}>{line}</Text>
					</Box>
				))}
			</Box>
		);
	}
	return (
		<Box
			borderStyle="round"
			borderColor={t.frame}
			paddingX={1}
			marginTop={1}
			flexDirection="column"
			flexShrink={0}
		>
			<Box>
				<Box flexShrink={0} marginRight={1}>
					<Text color={t[NO_PROVIDER_TONES.label]} bold>
						{copy.label}
					</Text>
				</Box>
				<Text color={t[NO_PROVIDER_TONES.lead]}>{copy.lead}</Text>
			</Box>
			{reason ? (
				// Aligned under the lead, so the label column stays clear.
				<Box paddingLeft={copy.label.length + 1}>
					<Text color={t[NO_PROVIDER_TONES.reason]}>{reason}</Text>
				</Box>
			) : null}
			{copy.paths.map((path) => (
				<Box key={path.n} flexDirection="column">
					<Box>
						<Box flexShrink={0} width={3}>
							<Text color={t[NO_PROVIDER_TONES.number]} bold>
								{path.n}
							</Text>
						</Box>
						<Text color={t[NO_PROVIDER_TONES.title]} bold>
							{path.title}
						</Text>
					</Box>
					{path.steps.map((step) => (
						<Box key={step} paddingLeft={3}>
							<Text color={t[NO_PROVIDER_TONES.step]}>{step}</Text>
						</Box>
					))}
				</Box>
			))}
		</Box>
	);
}

/** Renders the card only while no provider can answer; nothing otherwise. */
export function NoProviderNotice(
	props: GuidanceInput & { copy?: GuidanceCopy; compact?: boolean },
) {
	if (!needsProviderGuidance(props)) return null;
	return <NoProviderCard copy={props.copy} reason={props.unreachable} compact={props.compact} />;
}
