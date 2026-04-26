import { Box, Text } from "ink";
import type React from "react";

export interface ShortcutHintProps {
	keys: string;
	description: string;
}

export const ShortcutHint: React.FC<ShortcutHintProps> = ({
	keys,
	description,
}) => (
	<Box>
		<Text dimColor>{keys}</Text>
		<Text> </Text>
		<Text dimColor>{description}</Text>
	</Box>
);
