import React from "react";
import { Text, type TextProps } from "ink";

export const AppText: React.FC<TextProps> = ({ children, ...props }) => (
	<Text {...props}>{children}</Text>
);

export const MutedText: React.FC<TextProps> = ({ children, ...props }) => (
	<Text dimColor {...props}>
		{children}
	</Text>
);

export const Heading: React.FC<TextProps> = ({ children, ...props }) => (
	<Text bold color="cyan" {...props}>
		{children}
	</Text>
);

export interface LabelProps extends TextProps {
	color?: string;
}

export const Label: React.FC<LabelProps> = ({ children, color, ...props }) => (
	<Text bold color={color} {...props}>
		{children}
	</Text>
);

export const ErrorText: React.FC<TextProps> = ({ children, ...props }) => (
	<Text color="red" {...props}>
		{children}
	</Text>
);

export const SuccessText: React.FC<TextProps> = ({ children, ...props }) => (
	<Text color="green" {...props}>
		{children}
	</Text>
);

export const WarningText: React.FC<TextProps> = ({ children, ...props }) => (
	<Text color="yellow" {...props}>
		{children}
	</Text>
);
