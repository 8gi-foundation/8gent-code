import React from "react";
import { Box, type BoxProps } from "ink";

export interface StackProps extends BoxProps {
	gap?: number;
	children: React.ReactNode;
}

export const Stack: React.FC<StackProps> = ({
	gap = 0,
	children,
	...props
}) => {
	const items = React.Children.toArray(children);

	return (
		<Box flexDirection="column" {...props}>
			{items.map((child, index) => (
				<Box
					key={index}
					marginBottom={index < items.length - 1 ? gap : 0}
				>
					{child}
				</Box>
			))}
		</Box>
	);
};
