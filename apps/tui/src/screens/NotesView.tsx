/**
 * 8gent Code - Notes View
 *
 * Scratchpad for quick notes. Content persists to tab data.
 * Simple list-based note-taking with add/delete.
 */

import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { AppText, MutedText, Heading, Stack, Divider } from "../components/primitives/index.js";

interface NoteEntry {
  id: string;
  text: string;
  createdAt: string;
}

interface NotesViewProps {
  visible: boolean;
  data: Record<string, unknown>;
  onUpdateData: (data: Record<string, unknown>) => void;
  onClose: () => void;
}

export function NotesView({ visible, data, onUpdateData, onClose }: NotesViewProps) {
  const notes: NoteEntry[] = (data.notes as NoteEntry[]) || [];
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [inputMode, setInputMode] = useState(false);
  const [inputBuffer, setInputBuffer] = useState("");

  useInput((input, key) => {
    if (!visible) return;

    if (inputMode) {
      if (key.return) {
        if (inputBuffer.trim()) {
          const newNote: NoteEntry = {
            id: `note-${Date.now()}`,
            text: inputBuffer.trim(),
            createdAt: new Date().toISOString(),
          };
          const updated = [...notes, newNote];
          onUpdateData({ notes: updated });
          setSelectedIndex(updated.length - 1);
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
    if (key.upArrow) {
      setSelectedIndex((prev) => Math.max(0, prev - 1));
    }
    if (key.downArrow) {
      setSelectedIndex((prev) => Math.min(notes.length - 1, prev + 1));
    }
    if (input === "a" || input === "n") {
      setInputMode(true);
      setInputBuffer("");
    }
    if ((input === "d" || key.delete) && notes.length > 0) {
      const updated = notes.filter((_, i) => i !== selectedIndex);
      onUpdateData({ notes: updated });
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
        <Heading>Notes</Heading>
        <MutedText>  Scratchpad — {notes.length} note{notes.length !== 1 ? "s" : ""}</MutedText>
      </Box>

      <Divider />

      {inputMode ? (
        <Box marginY={1}>
          <Text color="cyan" bold>{">> "}</Text>
          <AppText>{inputBuffer}</AppText>
          <Text color="cyan">_</Text>
        </Box>
      ) : null}

      {notes.length === 0 && !inputMode ? (
        <Box paddingY={1}>
          <MutedText>No notes yet. Press [a] to add one.</MutedText>
        </Box>
      ) : (
        <Stack>
          {notes.map((note, i) => (
            <Box key={note.id}>
              <Text color={i === selectedIndex ? "cyan" : undefined}>
                {i === selectedIndex ? ">" : " "}{" "}
              </Text>
              <AppText>{note.text}</AppText>
              <Box flexGrow={1} />
              <MutedText>
                {new Date(note.createdAt).toLocaleDateString("en-US", {
                  month: "short",
                  day: "numeric",
                })}
              </MutedText>
            </Box>
          ))}
        </Stack>
      )}

      <Box marginTop={1}>
        <Divider />
      </Box>
      <MutedText>
        a=add  d=delete  arrows=navigate  ESC=back
      </MutedText>
    </Box>
  );
}
