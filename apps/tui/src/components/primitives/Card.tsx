import React from "react";
import { Box, type BoxProps } from "ink";
import { Heading } from "./AppText.js";

export interface CardProps extends BoxProps {
	title?: string;
	borderColor?: string;
	children: React.ReactNode;
}

export const Card: React.FC<CardProps> = ({
	title,
	borderColor = "blue",
	children,
	...props
}) => (
	<Box
		flexDirection="column"
		borderStyle="round"
		borderColor={borderColor}
		paddingX={1}
		paddingY={0}
		{...props}
	>
		{title && <Heading>{title}</Heading>}
		{children}
	</Box>
);
