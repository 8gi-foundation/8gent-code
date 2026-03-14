import React from "react";
import { Text } from "ink";

export interface DividerProps {
	width?: number;
	character?: string;
}

export const Divider: React.FC<DividerProps> = ({
	width = 60,
	character = "\u2500",
}) => <Text dimColor>{character.repeat(width)}</Text>;
