/**
 * 8gent Code - Typing Text Animation
 *
 * Character-by-character text reveal for that authentic CLI feel
 */

import { Box, Text } from "ink";
import React, { useState, useEffect, useCallback, useRef } from "react";
import { AppText, MutedText } from "./primitives/AppText.js";
import { Stack } from "./primitives/Stack.js";

interface TypingTextProps {
	text: string;
	speed?: number; // ms per character
	color?: string;
	onComplete?: () => void;
	cursor?: boolean;
	cursorChar?: string;
}

export function TypingText({
	text,
	speed = 15,
	color = "white",
	onComplete,
	cursor = true,
	cursorChar = "▌",
}: TypingTextProps) {
	const [displayedText, setDisplayedText] = useState("");
	const [showCursor, setShowCursor] = useState(true);
	const [isComplete, setIsComplete] = useState(false);

	// Stash latest onComplete in a ref so identity changes don't restart the typewriter.
	const onCompleteRef = useRef(onComplete);
	useEffect(() => {
		onCompleteRef.current = onComplete;
	}, [onComplete]);

	// Typing effect
	// no-cascading-set-state here is intentional: setIsComplete + invoking the callback
	// fires once when text finishes, distinct from the per-character setDisplayedText.
	// react-doctor-disable-next-line react-doctor/no-cascading-set-state
	useEffect(() => {
		if (displayedText.length < text.length) {
			const timeout = setTimeout(() => {
				setDisplayedText(text.slice(0, displayedText.length + 1));
			}, speed);
			return () => clearTimeout(timeout);
		}
		setIsComplete(true);
		onCompleteRef.current?.();
	}, [displayedText, text, speed]);

	// Cursor blink effect
	useEffect(() => {
		if (!cursor) return;

		const interval = setInterval(() => {
			setShowCursor((prev) => !prev);
		}, 530);

		return () => clearInterval(interval);
	}, [cursor]);

	return (
		<AppText color={color}>
			{displayedText}
			{cursor && !isComplete && <AppText color="cyan">{showCursor ? cursorChar : " "}</AppText>}
		</AppText>
	);
}

// Streaming text that accepts new chunks
interface StreamingTextProps {
	chunks: string[];
	speed?: number;
	color?: string;
}

export function StreamingText({ chunks, speed = 10, color = "white" }: StreamingTextProps) {
	// All three pieces of state are read in the effect below to compute the next character
	// AND the resulting displayedText is rendered to the screen — useRef would break the
	// per-character reveal. Cascading sets are intentional sequencing across chunk boundaries.
	// react-doctor-disable-next-line react-doctor/rerender-state-only-in-handlers
	const [currentChunkIndex, setCurrentChunkIndex] = useState(0);
	// react-doctor-disable-next-line react-doctor/rerender-state-only-in-handlers
	const [displayedText, setDisplayedText] = useState("");
	// react-doctor-disable-next-line react-doctor/rerender-state-only-in-handlers
	const [charIndex, setCharIndex] = useState(0);

	// react-doctor-disable-next-line react-doctor/no-cascading-set-state
	useEffect(() => {
		if (currentChunkIndex >= chunks.length) return;

		const currentChunk = chunks[currentChunkIndex];

		if (charIndex < currentChunk.length) {
			const timeout = setTimeout(() => {
				setDisplayedText((prev) => prev + currentChunk[charIndex]);
				setCharIndex((prev) => prev + 1);
			}, speed);
			return () => clearTimeout(timeout);
		}
		// Move to next chunk
		setCurrentChunkIndex((prev) => prev + 1);
		setCharIndex(0);
	}, [chunks, currentChunkIndex, charIndex, speed]);

	return <AppText color={color}>{displayedText}</AppText>;
}

// Typewriter with word-by-word animation
interface WordByWordProps {
	text: string;
	speed?: number; // ms per word
	color?: string;
	onComplete?: () => void;
}

export function WordByWord({ text, speed = 50, color = "white", onComplete }: WordByWordProps) {
	const words = text.split(" ");
	const [wordIndex, setWordIndex] = useState(0);

	// Stash latest onComplete in a ref so callback identity changes don't restart animation.
	const onCompleteRef = useRef(onComplete);
	useEffect(() => {
		onCompleteRef.current = onComplete;
	}, [onComplete]);

	useEffect(() => {
		if (wordIndex < words.length) {
			const timeout = setTimeout(() => {
				setWordIndex((prev) => prev + 1);
			}, speed);
			return () => clearTimeout(timeout);
		}
		onCompleteRef.current?.();
	}, [wordIndex, words.length, speed]);

	return (
		<AppText color={color} wrap="wrap">
			{words.slice(0, wordIndex).join(" ")}
			{wordIndex < words.length && <AppText color="cyan">▌</AppText>}
		</AppText>
	);
}

// Code block with syntax-aware typing
interface CodeTypingProps {
	code: string;
	language?: string;
	speed?: number;
}

export function CodeTyping({ code, language, speed = 8 }: CodeTypingProps) {
	// displayedCode is rendered; lineIndex / charIndex feed the per-tick reveal logic in the
	// effect AND the rendered slice. useRef would break the typewriter. Cascading sets across
	// line boundaries are intentional sequencing.
	// react-doctor-disable-next-line react-doctor/rerender-state-only-in-handlers
	const [displayedCode, setDisplayedCode] = useState("");
	// react-doctor-disable-next-line react-doctor/rerender-state-only-in-handlers
	const [lineIndex, setLineIndex] = useState(0);
	// react-doctor-disable-next-line react-doctor/rerender-state-only-in-handlers
	const [charIndex, setCharIndex] = useState(0);

	const lines = code.split("\n");

	// react-doctor-disable-next-line react-doctor/no-cascading-set-state
	useEffect(() => {
		if (lineIndex >= lines.length) return;

		const currentLine = lines[lineIndex];

		if (charIndex < currentLine.length) {
			const timeout = setTimeout(() => {
				setDisplayedCode((prev) => prev + currentLine[charIndex]);
				setCharIndex((prev) => prev + 1);
			}, speed);
			return () => clearTimeout(timeout);
		}
		// Move to next line
		setDisplayedCode((prev) => `${prev}\n`);
		setLineIndex((prev) => prev + 1);
		setCharIndex(0);
	}, [lines, lineIndex, charIndex, speed]);

	return (
		<Stack borderStyle="round" borderColor="blue" paddingX={1}>
			{language && (
				<Box marginBottom={1}>
					<MutedText>{language}</MutedText>
				</Box>
			)}
			<AppText color="green">{displayedCode}</AppText>
		</Stack>
	);
}
