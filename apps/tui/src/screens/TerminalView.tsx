/**
 * 8gent Code - Terminal View
 *
 * Renders a PTY-backed terminal tab. Each keystroke is forwarded
 * directly to the PTY (raw mode) so interactive REPLs (claude,
 * pi, openclaw, etc.) and line-editing inside the child app behave
 * normally. The PTY itself echoes typed input back via onData, which
 * is what the user sees on screen.
 *
 * Esc closes the tab. To send Esc to the child app, use Ctrl+[
 * (the canonical equivalent).
 */

import { Box, Text, useInput, useStdout } from "ink";
import type React from "react";
import { useEffect } from "react";
import { useTerminal } from "../hooks/useTerminal.js";

interface TerminalViewProps {
	tabId: string;
	cwd?: string;
	command?: string;
	args?: string[];
	label?: string;
	visible?: boolean;
	onClose?: () => void;
}

/**
 * Translate Ink's key descriptor to the byte sequence the PTY expects.
 * Returns null when the keystroke should be ignored.
 */
function keyToBytes(
	input: string,
	key: ReturnType<typeof useInput> extends never ? never : any,
): string | null {
	if (key.return) return "\r";
	if (key.backspace) return "\x7f";
	if (key.delete) return "\x1b[3~";
	if (key.tab && !key.shift) return "\t";
	if (key.upArrow) return "\x1b[A";
	if (key.downArrow) return "\x1b[B";
	if (key.rightArrow) return "\x1b[C";
	if (key.leftArrow) return "\x1b[D";
	if (key.pageUp) return "\x1b[5~";
	if (key.pageDown) return "\x1b[6~";
	if (key.ctrl && input) {
		// Map a-z to 0x01-0x1a (Ctrl-A through Ctrl-Z).
		const c = input.toLowerCase().charCodeAt(0);
		if (c >= 97 && c <= 122) return String.fromCharCode(c - 96);
	}
	if (key.meta) return null; // ignore meta-prefixed keys for now
	if (input && input.length > 0) return input;
	return null;
}

export const TerminalView: React.FC<TerminalViewProps> = ({
	tabId,
	cwd,
	command,
	args,
	label,
	visible = true,
	onClose,
}) => {
	const { stdout } = useStdout();
	const cols = stdout?.columns ?? 120;
	const rows = Math.max(10, (stdout?.rows ?? 30) - 6);

	const { lines, isRunning, pid, writeRaw, resize } = useTerminal(tabId, {
		cwd,
		command,
		args,
	});

	useEffect(() => {
		resize(cols, rows);
	}, [cols, rows, resize]);

	useInput(
		(input, key) => {
			if (key.escape && onClose) {
				onClose();
				return;
			}
			const bytes = keyToBytes(input, key);
			if (bytes) writeRaw(bytes);
		},
		{ isActive: visible },
	);

	const visibleLines = lines.slice(-(rows - 2));
	const headerLabel = label ?? "Terminal";

	return (
		<Box flexDirection="column" width="100%" height={rows + 4}>
			<Box borderStyle="single" borderColor="cyan" paddingX={1}>
				<Text color="cyan" bold>
					$ {headerLabel}
				</Text>
				<Text dimColor> pid:{pid ?? "—"} </Text>
				<Text color={isRunning ? "green" : "red"}>{isRunning ? "● running" : "○ stopped"}</Text>
				<Text dimColor> [Esc] back · keystrokes forwarded raw</Text>
			</Box>

			<Box flexDirection="column" flexGrow={1} paddingX={1} height={rows} overflow="hidden">
				{visibleLines.length === 0 ? (
					<Text dimColor>(starting…)</Text>
				) : (
					visibleLines.map((line, i) => (
						<Text key={i} wrap="truncate-end">
							{line}
						</Text>
					))
				)}
			</Box>
		</Box>
	);
};
