/**
 * OnboardingScreen - The first impression. Make it count.
 *
 * Design principles (8DO Moira):
 * - Each step is visually distinct with colour and spacing
 * - Progress indicator shows where you are
 * - Questions use cyan, user answers use yellow
 * - Confirmations use green
 * - Voice speaks each question aloud during onboarding
 *
 * Select-mode questions (kind: "select" in the OnboardingQuestion):
 * - Render via ink-select-input with arrow-key nav and built-in scroll
 * - Number-key shortcut: type the digit(s) and press Enter to jump
 * - Each row shows label + dim description
 * - Highlighted row uses brand amber #E8610A
 */

import { Box, Text, useInput, useStdout } from "ink";
import SelectInput from "ink-select-input";
import React, { useCallback, useEffect, useRef, useState } from "react";

interface OnboardingStep {
	question: string;
	answer?: string;
	status: "pending" | "active" | "done";
}

export interface OnboardingChoice {
	label: string;
	value: string;
	description?: string;
}

interface OnboardingScreenProps {
	steps: OnboardingStep[];
	currentQuestion: string;
	stepIndex: number;
	totalSteps: number;
	userName?: string;
	agentName?: string;
	/**
	 * If present, render this question as a scrollable select-list with arrow
	 * keys + number-key shortcut. When absent, the regular CommandInput owns
	 * input and the renderer just shows a "Type your answer" hint.
	 */
	selectChoices?: OnboardingChoice[];
	/** Fired when the user picks a choice (Enter on an arrow-highlighted row OR
	 * a digit-buffer + Enter shortcut). The string is the choice's `value`. */
	onSelect?: (value: string) => void;
}

/**
 * Hook: capture digit keys into a buffer so users can type "11" + Enter to
 * jump to option 11. Buffer flushes on Enter (selection) or after a short
 * idle window. SelectInput keeps consuming arrow keys in parallel.
 */
function useDigitShortcut(
	choices: OnboardingChoice[] | undefined,
	onSelect: ((value: string) => void) | undefined,
	active: boolean,
): { buffer: string } {
	const [buffer, setBuffer] = useState("");
	const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const clearIdle = useCallback(() => {
		if (idleTimerRef.current) {
			clearTimeout(idleTimerRef.current);
			idleTimerRef.current = null;
		}
	}, []);

	useEffect(
		() => () => {
			clearIdle();
		},
		[clearIdle],
	);

	useInput(
		(input, key) => {
			if (!choices || !onSelect) return;

			// Digit captured. Append to buffer (supports 1-99) and reset idle timer.
			if (/^[0-9]$/.test(input)) {
				setBuffer((prev) => {
					const next = (prev + input).slice(-2); // cap at 2 digits
					return next;
				});
				clearIdle();
				idleTimerRef.current = setTimeout(() => setBuffer(""), 800);
				return;
			}

			// Enter: if a digit buffer exists, resolve it. Otherwise let
			// SelectInput's own onSelect (bound to its highlighted item) win.
			if (key.return && buffer.length > 0) {
				clearIdle();
				const match = choices.find((c) => c.value === buffer);
				if (match) {
					onSelect(match.value);
				}
				setBuffer("");
				return;
			}

			// Backspace clears the digit buffer
			if (key.backspace || key.delete) {
				clearIdle();
				setBuffer("");
			}
		},
		{ isActive: active && !!choices && !!onSelect },
	);

	return { buffer };
}

export function OnboardingScreen({
	steps,
	currentQuestion,
	stepIndex,
	totalSteps,
	userName: _userName,
	agentName: _agentName,
	selectChoices,
	onSelect,
}: OnboardingScreenProps) {
	const { stdout } = useStdout();
	const termWidth = stdout?.columns ?? 80;
	const maxWidth = Math.min(termWidth - 4, 80);

	const isSelect = !!selectChoices && selectChoices.length > 0 && !!onSelect;

	const { buffer: digitBuffer } = useDigitShortcut(selectChoices, onSelect, isSelect);

	// SelectInput handles arrow-key paging; cap visible rows so long lists
	// scroll within a fixed viewport instead of overflowing the box.
	const VISIBLE_ROWS = 9;

	// Build SelectInput items. Each row: "N. Label" + dim description rendered
	// inline (SelectInput supports a custom itemComponent for richer rows).
	const items = (selectChoices ?? []).map((c) => ({
		label: `${c.value}. ${c.label}${c.description ? `  -  ${c.description}` : ""}`,
		value: c.value,
		key: c.value,
	}));

	return (
		<Box flexDirection="column" paddingX={2} paddingY={1}>
			{/* Header */}
			<Box marginBottom={1}>
				<Text color="cyan" bold>
					{"  "}8gent Code
				</Text>
				<Text dimColor> | </Text>
				<Text color="yellow" bold>
					Onboarding
				</Text>
			</Box>

			{/* Progress bar */}
			<Box marginBottom={1}>
				<Text dimColor>
					{"  "}Step {stepIndex + 1} of {totalSteps}{" "}
				</Text>
				{Array.from({ length: totalSteps }).map((_, i) => (
					<Text
						key={i}
						color={i < stepIndex ? "green" : i === stepIndex ? "cyan" : undefined}
						dimColor={i > stepIndex}
					>
						{i < stepIndex ? " * " : i === stepIndex ? " > " : " - "}
					</Text>
				))}
			</Box>

			{/* Divider */}
			<Box marginBottom={1}>
				<Text color="cyan">
					{"  "}
					{"~".repeat(Math.min(50, maxWidth - 4))}
				</Text>
			</Box>

			{/* Completed steps - compact */}
			{steps
				.filter((s) => s.status === "done")
				.map((step, i) => (
					<Box key={i} marginBottom={0} paddingLeft={2}>
						<Text color="green" bold>
							{"* "}
						</Text>
						<Text dimColor>{step.question.split("\n")[0].slice(0, 50)}</Text>
						{step.answer && (
							<Text color="yellow" bold>
								{" -> "}
								{step.answer.slice(0, 30)}
							</Text>
						)}
					</Box>
				))}

			{/* Spacer between history and active question */}
			{steps.some((s) => s.status === "done") && (
				<Box marginY={1}>
					<Text dimColor>
						{"  "}
						{"~".repeat(Math.min(30, maxWidth - 4))}
					</Text>
				</Box>
			)}

			{/* Active question - prompt body. One <Text> per line so Ink clears
				each row independently between renders (prevents the overlap
				artefact "(American)ilt-in):sive))" caused by multi-line text in
				a single <Text> node failing to fully clear on rerender). */}
			<Box
				flexDirection="column"
				paddingX={2}
				paddingY={1}
				marginBottom={1}
				borderStyle="round"
				borderColor="cyan"
				width={maxWidth}
			>
				{currentQuestion.split("\n").map((line, i) => {
					if (line.includes(":") && line.indexOf(":") < 20) {
						const [label, ...rest] = line.split(":");
						return (
							<Text key={i}>
								<Text bold>{label}:</Text>
								<Text>{rest.join(":")}</Text>
							</Text>
						);
					}
					return <Text key={i}>{line}</Text>;
				})}
			</Box>

			{/* Active input region. Two modes: */}
			{isSelect ? (
				<Box flexDirection="column" paddingLeft={2}>
					<SelectInput
						items={items}
						limit={VISIBLE_ROWS}
						onSelect={(item) => onSelect?.(String(item.value))}
						indicatorComponent={({ isSelected }) => (
							<Text color={isSelected ? "#E8610A" : undefined} bold={isSelected}>
								{isSelected ? ">" : " "}{" "}
							</Text>
						)}
						itemComponent={({ isSelected, label }) => (
							<Text color={isSelected ? "#E8610A" : undefined} bold={isSelected}>
								{label}
							</Text>
						)}
					/>
					<Box marginTop={1}>
						<Text dimColor>
							Arrow keys to navigate, Enter to select. Type a number then Enter for shortcut.
							{digitBuffer ? `  (typed: ${digitBuffer})` : ""}
						</Text>
					</Box>
				</Box>
			) : (
				<Box paddingLeft={2}>
					<Text dimColor>Type your answer and press Enter</Text>
				</Box>
			)}
		</Box>
	);
}
