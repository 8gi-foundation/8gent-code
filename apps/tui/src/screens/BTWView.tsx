/**
 * 8gent Code - BTW View
 *
 * Sidequest / "by the way" task queue. Quick capture of things to do later.
 * Incomplete items sort first, completed items below with strikethrough.
 * Data persists to ~/.8gent/tabs/btw.json
 */

import React, { useState, useEffect, useCallback } from "react";
import { Box, Text, useInput } from "ink";
import { AppText, MutedText, Heading, Stack, Divider } from "../components/primitives/index.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

const DATA_DIR = join(process.env.HOME || "~", ".8gent", "tabs");

interface BTWEntry {
  id: string;
  text: string;
  completed: boolean;
  createdAt: string;
  completedAt?: string;
}

interface BTWData {
  items: BTWEntry[];
}

function loadBTW(): BTWEntry[] {
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    const filepath = join(DATA_DIR, "btw.json");
    if (existsSync(filepath)) {
      const raw = JSON.parse(readFileSync(filepath, "utf-8")) as BTWData;
      return raw.items || [];
    }
  } catch {}
  return [];
}

function saveBTW(items: BTWEntry[]): void {
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(join(DATA_DIR, "btw.json"), JSON.stringify({ items }, null, 2));
  } catch {}
}

/** Sort: incomplete first, then completed. Within each group, by creation date. */
function sortItems(items: BTWEntry[]): BTWEntry[] {
  const incomplete = items.filter((i) => !i.completed).sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  );
  const complete = items.filter((i) => i.completed).sort(
    (a, b) => new Date(b.completedAt || b.createdAt).getTime() - new Date(a.completedAt || a.createdAt).getTime()
  );
  return [...incomplete, ...complete];
}

interface BTWViewProps {
  visible: boolean;
  data: Record<string, unknown>;
  onUpdateData: (data: Record<string, unknown>) => void;
  onClose: () => void;
}

export function BTWView({ visible, data, onUpdateData, onClose }: BTWViewProps) {
  const [items, setItems] = useState<BTWEntry[]>(() => {
    const fromFile = loadBTW();
    if (fromFile.length > 0) return sortItems(fromFile);
    const fromProps = data.items as BTWEntry[] | undefined;
    return fromProps ? sortItems(fromProps) : [];
  });
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [inputMode, setInputMode] = useState(false);
  const [inputBuffer, setInputBuffer] = useState("");

  const updateItems = useCallback((updated: BTWEntry[]) => {
    const sorted = sortItems(updated);
    setItems(sorted);
    saveBTW(sorted);
    onUpdateData({ items: sorted });
  }, [onUpdateData]);

  const pending = items.filter((i) => !i.completed);
  const completed = items.filter((i) => i.completed);

  // Clamp selectedIndex
  useEffect(() => {
    if (selectedIndex >= items.length && items.length > 0) {
      setSelectedIndex(items.length - 1);
    }
    if (items.length === 0) setSelectedIndex(0);
  }, [items.length, selectedIndex]);

  useInput((input, key) => {
    if (!visible) return;

    // --- ADD mode ---
    if (inputMode) {
      if (key.return) {
        if (inputBuffer.trim()) {
          const newItem: BTWEntry = {
            id: `btw-${Date.now()}`,
            text: inputBuffer.trim(),
            completed: false,
            createdAt: new Date().toISOString(),
          };
          updateItems([...items, newItem]);
          setSelectedIndex(0); // new incomplete item goes to top
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

    // --- NORMAL mode ---
    if (key.upArrow) {
      setSelectedIndex((prev) => Math.max(0, prev - 1));
    } else if (key.downArrow) {
      setSelectedIndex((prev) => Math.min(items.length - 1, prev + 1));
    } else if (input === "a" || input === "n") {
      setInputBuffer("");
      setInputMode(true);
    } else if ((input === " " || key.return) && items.length > 0) {
      // Toggle completion
      const target = items[selectedIndex];
      if (target) {
        const now = new Date().toISOString();
        const updated = items.map((item) =>
          item.id === target.id
            ? {
                ...item,
                completed: !item.completed,
                completedAt: !item.completed ? now : undefined,
              }
            : item
        );
        updateItems(updated);
      }
    } else if (input === "d" && items.length > 0) {
      const target = items[selectedIndex];
      if (target) {
        const updated = items.filter((i) => i.id !== target.id);
        updateItems(updated);
      }
    } else if (key.escape || input === "q") {
      onClose();
    }
  }, { isActive: visible });

  if (!visible) return null;

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box marginBottom={1}>
        <Heading>BTW</Heading>
        <MutedText>
          {"  "}Sidequests — {pending.length} pending, {completed.length} done
        </MutedText>
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
          {/* Separator between incomplete and completed */}
          {items.map((item, i) => {
            const isFirst = i === 0;
            const prevCompleted = i > 0 && items[i - 1].completed;
            const showSeparator = item.completed && !prevCompleted && !isFirst;

            return (
              <Box key={item.id} flexDirection="column">
                {showSeparator && (
                  <Box marginY={0}>
                    <MutedText>{"  "}--- completed ---</MutedText>
                  </Box>
                )}
                <Box>
                  <Text color={i === selectedIndex ? "cyan" : undefined}>
                    {i === selectedIndex ? ">" : " "}{" "}
                  </Text>
                  <Text color={item.completed ? "green" : "yellow"}>
                    {item.completed ? "[x]" : "[ ]"}{" "}
                  </Text>
                  {item.completed ? (
                    <Text dimColor strikethrough>{item.text}</Text>
                  ) : (
                    <AppText bold={i === selectedIndex}>{item.text}</AppText>
                  )}
                  <Box flexGrow={1} />
                  <MutedText>
                    {item.completed && item.completedAt
                      ? `done ${new Date(item.completedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`
                      : new Date(item.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                  </MutedText>
                </Box>
              </Box>
            );
          })}
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
