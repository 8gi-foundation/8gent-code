/**
 * typography — terminal-safe role primitives that mimic the 8gent.dev
 * typography system. Ink can't load fonts; the actual rendering depends
 * on the user's terminal profile (JetBrains Mono / Berkeley Mono /
 * Geist Mono / Commit Mono are the recommended choices). What we can
 * control here is weight, color, casing, and spacing.
 *
 * Roles:
 *   BrandText  — "8gent Code." identity. Cream wordmark + orange period.
 *   MonoCaps   — spaced-uppercase used for navigation / button labels.
 *   Prose      — warm body copy for transcript text.
 *   Hint       — muted helper text for keyboard hints, footnotes, etc.
 */

import { Text } from "ink";
import React from "react";
import { theme } from "./theme.js";

export function BrandText({ children }: { children: string }) {
	return (
		<Text bold color={theme.color.cream}>
			{children}
			<Text color={theme.color.orange}>.</Text>
		</Text>
	);
}

export function MonoCaps({
	children,
	color = theme.color.muted,
}: {
	children: string;
	color?: string;
}) {
	return <Text color={color}>{children.toUpperCase().split("").join(" ")}</Text>;
}

export function Prose({ children }: { children: string }) {
	return (
		<Text color={theme.color.prose} wrap="wrap">
			{children}
		</Text>
	);
}

export function Hint({ children }: { children: string }) {
	return <Text color={theme.color.muted}>{children}</Text>;
}
