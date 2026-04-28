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
import { probeProviders, type ProviderStatus } from "../lib/provider-health.js";

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

export type OnboardingProviderId = "ollama" | "lmstudio" | "apfel";

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
	/**
	 * For providerCheck steps: which engine to probe + the install hint to
	 * show if it isn't running. The renderer probes once on entry, shows
	 * status row + (if missing) install hint + Skip button. Pressing Enter
	 * fires onProviderResolve("live") or onProviderResolve("skip").
	 */
	providerCheck?: {
		provider: OnboardingProviderId;
		installHint: string;
	};
	onProviderResolve?: (result: "live" | "skip") => void;
	/**
	 * For agentName steps: hint to show under the input. The user's actual
	 * input still goes through the normal CommandInput; we just show the
	 * default value so they know what Enter accepts.
	 */
	agentNameDefault?: string;
}

interface ProviderProbeState {
	status: "loading" | "done" | "error";
	statuses: ProviderStatus[];
	models: string[];
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

/**
 * shouldShowInstallHint — exported pure helper used by both the renderer
 * and the smoke harness. Returns true if the install hint should be
 * rendered for the current probe state. Logic: show whenever the current
 * provider isn't live (so the user has guidance), AND the probe finished.
 * While loading, no hint. On error, show hint as a safe default.
 */
export function shouldShowInstallHint(
	provider: OnboardingProviderId,
	probe: ProviderProbeState,
): boolean {
	if (probe.status === "loading") return false;
	if (probe.status === "error") return true;
	const match = probe.statuses.find((s) => s.name === provider);
	return !match?.live;
}

/**
 * Probe one provider's chat models endpoint and return the list of model
 * IDs (filtering obvious embedding models). Used by the providerCheck step
 * so the user can see what's actually loaded, not just "live".
 */
async function fetchProviderModels(
	provider: OnboardingProviderId,
): Promise<string[]> {
	const isEmbed = (id: string): boolean =>
		/embed|embedding|nomic|bge-/i.test(id);
	try {
		if (provider === "ollama") {
			const host = process.env.OLLAMA_HOST || "http://localhost:11434";
			const ctrl = new AbortController();
			const t = setTimeout(() => ctrl.abort(), 1500);
			const res = await fetch(`${host}/api/tags`, { signal: ctrl.signal });
			clearTimeout(t);
			if (!res.ok) return [];
			const data = (await res.json()) as { models?: Array<{ name: string }> };
			return (data.models ?? [])
				.map((m) => m.name)
				.filter((n) => !isEmbed(n));
		}
		// lmstudio + apfel both expose /v1/models (OpenAI-compat)
		const hostBase =
			provider === "lmstudio"
				? process.env.LM_STUDIO_HOST || "http://localhost:1234"
				: (process.env.APFEL_BASE_URL?.replace(/\/v1$/, "") || "http://localhost:11500");
		const ctrl = new AbortController();
		const t = setTimeout(() => ctrl.abort(), 1500);
		const res = await fetch(`${hostBase}/v1/models`, { signal: ctrl.signal });
		clearTimeout(t);
		if (!res.ok) return [];
		const data = (await res.json()) as { data?: Array<{ id: string }> };
		return (data.data ?? []).map((m) => m.id).filter((id) => !isEmbed(id));
	} catch {
		return [];
	}
}

const PROVIDER_LABELS: Record<OnboardingProviderId, string> = {
	ollama: "Ollama",
	lmstudio: "LM Studio",
	apfel: "apfel (Apple Foundation)",
};

export function OnboardingScreen({
	steps,
	currentQuestion,
	stepIndex,
	totalSteps,
	userName: _userName,
	agentName: _agentName,
	selectChoices,
	onSelect,
	providerCheck,
	onProviderResolve,
	agentNameDefault,
}: OnboardingScreenProps) {
	const { stdout } = useStdout();
	const termWidth = stdout?.columns ?? 80;
	const maxWidth = Math.min(termWidth - 4, 80);

	const isProviderCheck = !!providerCheck && !!onProviderResolve;
	const isSelect =
		!isProviderCheck && !!selectChoices && selectChoices.length > 0 && !!onSelect;

	const { buffer: digitBuffer } = useDigitShortcut(selectChoices, onSelect, isSelect);

	// ── Provider probe state ─────────────────────────────────
	// Reset to "loading" whenever we land on a new providerCheck step so the
	// user always sees a fresh probe (especially when restarting onboarding).
	const [probe, setProbe] = useState<ProviderProbeState>({
		status: "loading",
		statuses: [],
		models: [],
	});
	useEffect(() => {
		if (!isProviderCheck) return;
		let cancelled = false;
		setProbe({ status: "loading", statuses: [], models: [] });
		(async () => {
			try {
				const result = await probeProviders();
				const live = result.statuses.find(
					(s) => s.name === providerCheck?.provider,
				)?.live;
				const models =
					live && providerCheck
						? await fetchProviderModels(providerCheck.provider)
						: [];
				if (cancelled) return;
				setProbe({
					status: "done",
					statuses: result.statuses,
					models,
				});
			} catch {
				if (cancelled) return;
				setProbe({ status: "error", statuses: [], models: [] });
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [isProviderCheck, providerCheck?.provider]);

	// ── Provider check input handling ────────────────────────
	// Enter advances. We pass "live" if the engine responded, "skip" otherwise.
	// The processor records the result; either way the flow continues.
	useInput(
		(_input, key) => {
			if (!isProviderCheck || !onProviderResolve) return;
			if (probe.status === "loading") return; // don't fire mid-probe
			if (key.return) {
				const live =
					probe.statuses.find((s) => s.name === providerCheck?.provider)?.live ??
					false;
				onProviderResolve(live ? "live" : "skip");
			}
		},
		{ isActive: isProviderCheck },
	);

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

			{/* Active question - prompt body. One flat <Text> per line so Ink clears
				each row independently between renders. Earlier versions wrapped
				colon-prefixed lines in nested <Text bold>label:</Text><Text>rest</Text>
				to bold the label, but Ink v6 fails to clear those nested rows on
				rerender. The previous frame's content composites under the new
				one and produces artefacts like "podjamzetected:e Infinite Gentleman."
				(value + tail-of-prior-line + tail-of-other-prior-line). Flat Text
				per row avoids the bug entirely. */}
			<Box
				flexDirection="column"
				paddingX={2}
				paddingY={1}
				marginBottom={1}
				borderStyle="round"
				borderColor="cyan"
				width={maxWidth}
			>
				{currentQuestion.split("\n").map((line, i) => (
					<Text key={i}>{line}</Text>
				))}
			</Box>

			{/* Active input region. Three modes: select, providerCheck, free text. */}
			{isProviderCheck && providerCheck ? (
				<Box flexDirection="column" paddingLeft={2}>
					{probe.status === "loading" ? (
						<Text color="cyan">
							Probing {PROVIDER_LABELS[providerCheck.provider]}...
						</Text>
					) : (
						<>
							{(() => {
								const live = probe.statuses.find(
									(s) => s.name === providerCheck.provider,
								)?.live;
								const label = PROVIDER_LABELS[providerCheck.provider];
								if (live) {
									const modelLine =
										probe.models.length > 0
											? `, ${probe.models.length} chat model${probe.models.length === 1 ? "" : "s"} loaded`
											: "";
									return (
										<Text color="green" bold>
											{`* ${label} detected${modelLine}`}
										</Text>
									);
								}
								return (
									<Text color="yellow" bold>{`x ${label} not running`}</Text>
								);
							})()}
							{probe.status === "done" &&
								probe.models.length > 0 && (
									<Box flexDirection="column" marginTop={1}>
										<Text dimColor>Available models:</Text>
										{probe.models.slice(0, 5).map((m) => (
											<Text key={m} dimColor>
												{`  - ${m}`}
											</Text>
										))}
										{probe.models.length > 5 && (
											<Text dimColor>
												{`  ... and ${probe.models.length - 5} more`}
											</Text>
										)}
									</Box>
								)}
							{shouldShowInstallHint(providerCheck.provider, probe) && (
								<Box flexDirection="column" marginTop={1}>
									<Text color="cyan" bold>
										Install hint:
									</Text>
									{providerCheck.installHint
										.split("\n")
										.map((line, i) => (
											<Text key={i} dimColor>
												{line}
											</Text>
										))}
								</Box>
							)}
							<Box marginTop={1}>
								<Text dimColor>
									{shouldShowInstallHint(providerCheck.provider, probe)
										? "Press Enter to skip and continue"
										: "Press Enter to continue"}
								</Text>
							</Box>
						</>
					)}
				</Box>
			) : isSelect ? (
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
					<Text dimColor>
						{agentNameDefault
							? `Type a name and press Enter, or Enter alone to keep "${agentNameDefault}"`
							: "Type your answer and press Enter"}
					</Text>
				</Box>
			)}
		</Box>
	);
}
