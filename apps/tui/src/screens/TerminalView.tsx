/**
 * 8gent Code - Terminal View
 *
 * Renders a PTY-backed terminal tab in Ink.
 * Uses useTerminal hook to manage the shell process.
 * Input goes directly to the PTY (not the chat agent).
 * Agents can also write to the PTY via write_terminal tool.
 */

import React, { useState, useCallback, useEffect } from "react";
import { Box, Text, useInput, useStdout } from "ink";
import { useTerminal } from "../hooks/useTerminal.js";

interface TerminalViewProps {
  tabId: string;
  cwd?: string;
  visible?: boolean;
  onClose?: () => void;
}

export const TerminalView: React.FC<TerminalViewProps> = ({
  tabId,
  cwd,
  visible = true,
  onClose,
}) => {
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 120;
  const rows = Math.max(10, (stdout?.rows ?? 30) - 6); // leave room for tab bar + input

  const { lines, isRunning, pid, write, resize } = useTerminal(tabId, cwd);

  const [inputBuf, setInputBuf] = useState("");

  // Resize PTY when terminal dimensions change
  useEffect(() => {
    resize(cols, rows);
  }, [cols, rows, resize]);

  // Handle keyboard input — only active when this terminal tab is visible
  useInput((input, key) => {
    if (key.escape && onClose) {
      onClose();
      return;
    }

    if (key.return) {
      write(inputBuf);
      setInputBuf("");
      return;
    }

    if (key.backspace || key.delete) {
      setInputBuf((prev) => prev.slice(0, -1));
      return;
    }

    if (key.ctrl && input === "c") {
      // Send SIGINT (Ctrl+C) to PTY
      write("\x03");
      setInputBuf("");
      return;
    }

    if (key.ctrl && input === "d") {
      write("\x04");
      return;
    }

    // Forward plain Tab to PTY for autocomplete; let Shift+Tab fall through for tab cycling
    if (key.tab && !key.shift) {
      write("\t");
      return;
    }

    // Regular character input
    if (input && !key.ctrl && !key.meta) {
      setInputBuf((prev) => prev + input);
    }
  }, { isActive: visible });

  // Show last N lines that fit in the viewport
  const visibleLines = lines.slice(-(rows - 2));

  return (
    <Box flexDirection="column" width="100%" height={rows + 4}>
      {/* Header */}
      <Box borderStyle="single" borderColor="cyan" paddingX={1}>
        <Text color="cyan" bold>
          $ Terminal
        </Text>
        <Text color="gray"> pid:{pid ?? "—"} </Text>
        <Text color={isRunning ? "green" : "red"}>
          {isRunning ? "● running" : "○ stopped"}
        </Text>
        <Text color="gray">  [Esc] back  [Ctrl+C] interrupt  [Ctrl+D] EOF</Text>
      </Box>

      {/* Output area */}
      <Box
        flexDirection="column"
        flexGrow={1}
        paddingX={1}
        height={rows}
        overflow="hidden"
      >
        {visibleLines.length === 0 ? (
          <Text color="gray" dimColor>
            (shell starting…)
          </Text>
        ) : (
          visibleLines.map((line, i) => (
            <Text key={i} wrap="truncate-end">
              {line}
            </Text>
          ))
        )}
      </Box>

      {/* Input prompt */}
      <Box paddingX={1} borderStyle="single" borderColor="gray">
        <Text color="green">❯ </Text>
        <Text>{inputBuf}</Text>
        <Text color="green" bold>
          ▌
        </Text>
      </Box>
    </Box>
  );
};
