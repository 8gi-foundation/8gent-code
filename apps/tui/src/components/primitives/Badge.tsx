import React from "react";
import { Text } from "ink";

export interface BadgeProps {
	label: string;
	color?: string;
	variant?: "solid" | "outline";
}

export const Badge: React.FC<BadgeProps> = ({
	label,
	color = "cyan",
	variant = "solid",
}) => {
	if (variant === "outline") {
		return (
			<Text bold color={color}>
				[{label}]
			</Text>
		);
	}

	return (
		<Text inverse bold color={color}>
			{" "}
			{label}{" "}
		</Text>
	);
};
