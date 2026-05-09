import { Box, type BoxProps } from "ink";
import React from "react";

export interface InlineProps extends BoxProps {
	gap?: number;
	children: React.ReactNode;
}

export const Inline: React.FC<InlineProps> = ({ gap = 1, children, ...props }) => {
	const items = React.Children.toArray(children);

	return (
		<Box flexDirection="row" {...props}>
			{/* items comes from React.Children.toArray which already assigns its own internal keys to each child; the wrapper Box index here is a positional spacing wrapper, not a list-identity key. */}
			{items.map((child, index) => (
				// react-doctor-disable-next-line react-doctor/no-array-index-as-key
				<Box key={index} marginRight={index < items.length - 1 ? gap : 0}>
					{child}
				</Box>
			))}
		</Box>
	);
};
