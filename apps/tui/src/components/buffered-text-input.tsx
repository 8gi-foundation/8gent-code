/**
 * 8gent Code - Burst-safe single-line text input
 *
 * Drop-in for ink-text-input's default export (same props we use), with one
 * difference: the current value and cursor live in refs that are updated
 * synchronously on every keystroke.
 *
 * Why: ink-text-input reads `value` from the render closure. Ink re-binds
 * useInput handlers only after React flushes passive effects, so when a
 * terminal burst (fast typing, a paste, tmux send-keys) delivers several
 * stdin reads before that flush, each read starts from the stale value.
 * Characters are dropped and an Enter in the burst submits the stale (often
 * empty) value, so the message needs a second Enter.
 */

import { Text, useInput } from "ink";
import React, { useRef, useState } from "react";
import { isApprovalKeyClaimed } from "../hooks/useApprovalCard.js";

export interface BufferedTextInputProps {
	value: string;
	onChange: (value: string) => void;
	onSubmit?: (value: string) => void;
	placeholder?: string;
	focus?: boolean;
}

export function BufferedTextInput({
	value,
	onChange,
	onSubmit,
	placeholder = "",
	focus = true,
}: BufferedTextInputProps) {
	const valueRef = useRef(value);
	const cursorRef = useRef(value.length);
	// Bumped to re-render when only the cursor moves.
	const [, setTick] = useState(0);

	// The parent owns the value. A render always carries its latest state, so
	// adopt it; keystrokes between renders keep building on the ref.
	// A value that differs from the ref came from the parent (history, Tab
	// accept, clear after submit, input transform): cursor goes to the end.
	if (valueRef.current !== value) {
		valueRef.current = value;
		cursorRef.current = value.length;
	}

	useInput(
		(input, key) => {
			if (key.upArrow || key.downArrow || key.tab || (key.ctrl && input === "c")) return;
			// Y/N/E/S answer a pending approval card; they are not text (#3055).
			if (isApprovalKeyClaimed(input, key)) return;

			const current = valueRef.current;
			const cursor = Math.min(cursorRef.current, current.length);

			if (key.return) {
				onSubmit?.(current);
				return;
			}

			let next = current;
			let nextCursor = cursor;
			if (key.leftArrow) {
				nextCursor = Math.max(0, cursor - 1);
			} else if (key.rightArrow) {
				nextCursor = Math.min(current.length, cursor + 1);
			} else if (key.backspace || key.delete) {
				if (cursor > 0) {
					next = current.slice(0, cursor - 1) + current.slice(cursor);
					nextCursor = cursor - 1;
				}
			} else if (input && !key.ctrl) {
				// Ink reports Ctrl+P as input "p" with key.ctrl, and hands it to
				// every active handler. Ctrl+letter is a shortcut, never text,
				// or the app's shortcut also types its letter here (#3166).
				next = current.slice(0, cursor) + input + current.slice(cursor);
				nextCursor = cursor + input.length;
			}

			valueRef.current = next;
			cursorRef.current = nextCursor;
			if (next !== current) onChange(next);
			else setTick((n) => n + 1);
		},
		{ isActive: focus },
	);

	if (!value) {
		if (!focus) return <Text dimColor>{placeholder}</Text>;
		return (
			<Text>
				<Text inverse>{placeholder[0] ?? " "}</Text>
				<Text dimColor>{placeholder.slice(1)}</Text>
			</Text>
		);
	}

	if (!focus) return <Text>{value}</Text>;

	const cursor = Math.min(cursorRef.current, value.length);
	return (
		<Text>
			{value.slice(0, cursor)}
			<Text inverse>{value[cursor] ?? " "}</Text>
			{value.slice(cursor + 1)}
		</Text>
	);
}
