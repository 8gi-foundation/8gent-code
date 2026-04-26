/**
 * 8gent Code - Turth Prompt (TUI)
 *
 * Inline overlay shown on first use of a scoped capability.
 * Five options: once / session / project / always / deny.
 *
 * The component exposes a declarative API via `useTurthPromptSurface`
 * which registers the TUI as the active Turth prompt surface while the
 * hook is mounted. A prompt request pushes a pending entry into local
 * state and resolves when the user picks a scope.
 */

import { Box } from "ink";
import type React from "react";
import { useCallback, useEffect, useState } from "react";
import {
	type ApprovalScope,
	type TurthRequest,
	registerPromptSurface,
} from "../../../../packages/permissions/turth.js";
import {
	AppText,
	Card,
	Heading,
	MutedText,
	Stack,
} from "./primitives/index.js";
import { SelectInput, type SelectOption } from "./select-input.js";

interface PendingPrompt extends TurthRequest {
	resolve: (scope: ApprovalScope) => void;
}

const SCOPE_OPTIONS: SelectOption<ApprovalScope>[] = [
	{
		label: "Allow once",
		value: "once",
		description: "This call only. Nothing is cached.",
	},
	{
		label: "Allow for session",
		value: "session",
		description: "Remember until the TUI exits.",
	},
	{
		label: "Allow for this project",
		value: "project",
		description: "Remember for this working directory.",
	},
	{
		label: "Allow always",
		value: "always",
		description:
			"Persist across restarts. Stored in ~/.8gent/user-policy.json.",
	},
	{
		label: "Deny",
		value: "deny",
		description: "Reject this call. Re-prompt next time.",
	},
];

/**
 * Mount inside the TUI tree. While mounted, this component is the active
 * Turth prompt surface. When a request arrives, an overlay is rendered
 * and the user's scope choice resolves the promise back to the agent.
 */
export function TurthPrompt(): React.JSX.Element | null {
	const [pending, setPending] = useState<PendingPrompt | null>(null);

	useEffect(() => {
		registerPromptSurface((req: TurthRequest) => {
			return new Promise<ApprovalScope>((resolve) => {
				setPending({ ...req, resolve });
			});
		});
		return () => registerPromptSurface(null);
	}, []);

	const onSelect = useCallback(
		(scope: ApprovalScope) => {
			if (!pending) return;
			pending.resolve(scope);
			setPending(null);
		},
		[pending],
	);

	const onCancel = useCallback(() => {
		if (!pending) return;
		// Cancel = deny for safety. Never default to allow.
		pending.resolve("deny");
		setPending(null);
	}, [pending]);

	if (!pending) return null;

	return (
		<Box marginTop={1} flexDirection="column">
			<Card borderColor="yellow">
				<Stack gap={0}>
					<Heading color="yellow">Permission requested</Heading>
					<AppText>{pending.summary}</AppText>
					{pending.detail ? <MutedText>{pending.detail}</MutedText> : null}
					<MutedText>Capability: {pending.capability}</MutedText>
				</Stack>
				<Box marginTop={1}>
					<SelectInput<ApprovalScope>
						options={SCOPE_OPTIONS}
						onSelect={onSelect}
						onCancel={onCancel}
						title="Choose scope"
						searchable={false}
						highlightColor="yellow"
					/>
				</Box>
			</Card>
		</Box>
	);
}

export default TurthPrompt;
