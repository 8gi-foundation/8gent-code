import React from "react";
import { Box, type BoxProps } from "ink";

export interface InlineProps extends BoxProps {
	gap?: number;
	children: React.ReactNode;
}

export const Inline: React.FC<InlineProps> = ({
	gap = 1,
	children,
	...props
}) => {
	const items = React.Children.toArray(children);

	return (
		<Box flexDirection="row" {...props}>
			{items.map((child, index) => (
				<Box
					key={index}
					marginRight={index < items.length - 1 ? gap : 0}
				>
					{child}
				</Box>
			))}
		</Box>
	);
};
