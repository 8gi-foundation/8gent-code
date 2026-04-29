/**
 * 8gent Code - Window Terminal View
 *
 * Status / control pane for a /term tab whose process is running in
 * a real Terminal.app window (Plan B from PR 3d). The actual CLI lives
 * in the OS terminal — this tab is the orchestration surface: shows
 * liveness, lets the user focus the window, kill the process, or
 * (eventually) reattach to its output stream.
 */

import { Box, Text, useInput } from "ink";
import type React from "react";
import { useCallback, useEffect, useState } from "react";
import { focusWindow, isPidAlive, killSession } from "../../../../packages/terminal-tab/index.js";

interface WindowTerminalViewProps {
	sessionId: string;
	pid: number;
	command: string;
	args: string[];
	label: string;
	startedAt: string;
	visible?: boolean;
	onClose?: () => void;
	/** Called when the user kills the session — lets app.tsx clean up the tab. */
	onKill?: () => void;
}

function formatElapsed(startIso: string): string {
	const ms = Date.now() - new Date(startIso).getTime();
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ${s % 60}s`;
	const h = Math.floor(m / 60);
	return `${h}h ${m % 60}m`;
}

export const WindowTerminalView: React.FC<WindowTerminalViewProps> = ({
	sessionId,
	pid,
	command,
	args,
	label,
	startedAt,
	visible = true,
	onClose,
	onKill,
}) => {
	const [alive, setAlive] = useState<boolean>(() => isPidAlive(pid));
	const [tick, setTick] = useState(0);

	// Poll liveness every 2s
	useEffect(() => {
		const id = setInterval(() => {
			setAlive(isPidAlive(pid));
			setTick((t) => t + 1);
		}, 2000);
		return () => clearInterval(id);
	}, [pid]);

	const handleFocus = useCallback(() => {
		void focusWindow(sessionId);
	}, [sessionId]);

	const handleKill = useCallback(() => {
		killSession(pid);
		setAlive(false);
		onKill?.();
	}, [pid, onKill]);

	useInput(
		(input, key) => {
			if (key.escape && onClose) {
				onClose();
				return;
			}
			const c = input.toLowerCase();
			if (c === "f") handleFocus();
			else if (c === "k") handleKill();
		},
		{ isActive: visible },
	);

	const elapsed = formatElapsed(startedAt);
	const fullCmd = args.length > 0 ? `${command} ${args.join(" ")}` : command;

	return (
		<Box flexDirection="column" padding={1}>
			<Box borderStyle="round" borderColor={alive ? "green" : "red"} paddingX={2} paddingY={1}>
				<Box flexDirection="column">
					<Box>
						<Text bold color={alive ? "green" : "red"}>
							{alive ? "● running" : "○ stopped"}
						</Text>
						<Text>{"   "}</Text>
						<Text bold>{label}</Text>
					</Box>
					<Box marginTop={1}>
						<Text dimColor>session: {sessionId}</Text>
					</Box>
					<Box>
						<Text dimColor>
							pid: {pid}
							{"   "}elapsed: {elapsed}
							{"   "}command: {fullCmd}
						</Text>
					</Box>
					<Box marginTop={1}>
						<Text dimColor>
							The process is running in a separate Terminal.app window. Use that window to interact
							with it. This tab is its control panel.
						</Text>
					</Box>
				</Box>
			</Box>

			<Box marginTop={1} paddingX={1}>
				<Text dimColor>
					[F] focus the Terminal.app window {"   "}
					[K] kill the process {"   "}
					[Esc] back to chat
				</Text>
			</Box>

			{tick > 0 ? null : null /* dependency on tick to satisfy eslint exhaustive-deps */}
		</Box>
	);
};
