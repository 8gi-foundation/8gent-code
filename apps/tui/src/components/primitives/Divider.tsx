import { Text } from "ink";
import type React from "react";

export interface DividerProps {
	width?: number;
	character?: string;
}

export const Divider: React.FC<DividerProps> = ({ width = 60, character = "\u2500" }) => (
	<Text dimColor wrap="truncate-end">
		{character.repeat(width)}
	</Text>
);
