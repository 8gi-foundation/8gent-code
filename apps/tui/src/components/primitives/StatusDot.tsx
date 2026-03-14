import React from "react";
import { Text } from "ink";

export type StatusType = "success" | "error" | "warning" | "info" | "idle";

export interface StatusDotProps {
	status: StatusType;
}

const STATUS_CONFIG: Record<StatusType, { symbol: string; color?: string; dimColor?: boolean }> = {
	success: { symbol: "\u25CF", color: "green" },
	error: { symbol: "\u25CF", color: "red" },
	warning: { symbol: "\u25CF", color: "yellow" },
	info: { symbol: "\u25CF", color: "cyan" },
	idle: { symbol: "\u25CB", dimColor: true },
};

export const StatusDot: React.FC<StatusDotProps> = ({ status }) => {
	const config = STATUS_CONFIG[status];

	return (
		<Text color={config.color} dimColor={config.dimColor}>
			{config.symbol}
		</Text>
	);
};
