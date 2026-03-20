/**
 * 8gent Code - BTW View
 *
 * Sidequest / "by the way" task queue. Quick capture of things to do later.
 */

import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { AppText, MutedText, Heading, Stack, Divider } from "../components/primitives/index.js";

interface BTWEntry {
  id: string;
  text: string;
  done: boolean;
  createdAt: string;
}

interface BTWViewProps {
  visible: boolean;
  data: Record<string, unknown>;
  onUpdateData: (data: Record<string, unknown>) => void;
  onClose: () => void;
}

export function BTWView({ visible, data, onUpdateData, onClose }: BTWViewProps) {
  const items: BTWEntry[] = (data.items as BTWEntry[]) || [];
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [inputMode, setInputMode] = useState(false);
  const [inputBuffer, setInputBuffer] = useState("");

  const pending = items.filter((i) => !i.done);
  const completed = items.filter((i) => i.done);

  useInput((input, key) => {
    if (!visible) return;

    if (inputMode) {
      if (key.return) {
        if (inputBuffer.trim()) {
          const newItem: BTWEntry = {
            id: `btw-${Date.now()}`,
            text: inputBuffer.trim(),
            done: false,
            createdAt: new Date().toISOString(),
          };
          const updated = [...items, newItem];
          onUpdateData({ items: updated });
          setSelectedIndex(pending.length); // select the new item
        }
        setInputBuffer("");
        setInputMode(false);
        return;
      }
      if (key.escape) {
        setInputBuffer("");
        setInputMode(false);
        return;
      }
      if (key.backspace || key.delete) {
        setInputBuffer((prev) => prev.slice(0, -1));
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        setInputBuffer((prev) => prev + input);
        return;
      }
      return;
    }

    // Normal mode
    if (key.upArrow) setSelectedIndex((prev) => Math.max(0, prev - 1));
    if (key.downArrow) setSelectedIndex((prev) => Math.min(items.length - 1, prev + 1));
    if (input === "a" || input === "n") {
      setInputMode(true);
      setInputBuffer("");
    }
    if (input === " " || key.return) {
      // Toggle done
      if (items.length > 0) {
        const updated = items.map((item, i) =>
          i === selectedIndex ? { ...item, done: !item.done } : item
        );
        onUpdateData({ items: updated });
      }
    }
    if ((input === "d" || key.delete) && items.length > 0) {
      const updated = items.filter((_, i) => i !== selectedIndex);
      onUpdateData({ items: updated });
      setSelectedIndex(Math.min(selectedIndex, Math.max(0, updated.length - 1)));
    }
    if (key.escape || input === "q") {
      onClose();
    }
  });

  if (!visible) return null;

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box marginBottom={1}>
        <Heading>BTW</Heading>
        <MutedText>  Sidequests — {pending.length} pending, {completed.length} done</MutedText>
      </Box>

      <Divider />

      {inputMode && (
        <Box marginY={1}>
          <Text color="yellow" bold>{"btw: "}</Text>
          <AppText>{inputBuffer}</AppText>
          <Text color="cyan">_</Text>
        </Box>
      )}

      {items.length === 0 && !inputMode ? (
        <Box paddingY={1}>
          <MutedText>No sidequests yet. Press [a] to add one.</MutedText>
        </Box>
      ) : (
        <Stack>
          {items.map((item, i) => (
            <Box key={item.id}>
              <Text color={i === selectedIndex ? "cyan" : undefined}>
                {i === selectedIndex ? ">" : " "}{" "}
              </Text>
              <Text color={item.done ? "green" : "yellow"}>
                {item.done ? "[x]" : "[ ]"}{" "}
              </Text>
              {item.done ? (
                <Text dimColor strikethrough>{item.text}</Text>
              ) : (
                <AppText>{item.text}</AppText>
              )}
            </Box>
          ))}
        </Stack>
      )}

      <Box marginTop={1}>
        <Divider />
      </Box>
      <MutedText>
        a=add  Space/Enter=toggle  d=delete  arrows=navigate  ESC=back
      </MutedText>
    </Box>
  );
}
