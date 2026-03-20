/**
 * 8gent Code - Notes View
 *
 * Persistent scratchpad with multiple notes. Each note has a title (first line)
 * and content body. Supports add, delete, view/edit with keyboard navigation.
 * Data persists to ~/.8gent/tabs/notes.json
 */

import React, { useState, useEffect, useCallback } from "react";
import { Box, Text, useInput } from "ink";
import { AppText, MutedText, Heading, Stack, Divider } from "../components/primitives/index.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

const DATA_DIR = join(process.env.HOME || "~", ".8gent", "tabs");

interface NoteEntry {
  id: string;
  title: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}

interface NotesData {
  notes: NoteEntry[];
}

function loadNotes(): NoteEntry[] {
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    const filepath = join(DATA_DIR, "notes.json");
    if (existsSync(filepath)) {
      const raw = JSON.parse(readFileSync(filepath, "utf-8")) as NotesData;
      return raw.notes || [];
    }
  } catch {}
  return [];
}

function saveNotes(notes: NoteEntry[]): void {
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(join(DATA_DIR, "notes.json"), JSON.stringify({ notes }, null, 2));
  } catch {}
}

type Mode = "list" | "add" | "view" | "edit";

interface NotesViewProps {
  visible: boolean;
  data: Record<string, unknown>;
  onUpdateData: (data: Record<string, unknown>) => void;
  onClose: () => void;
  /** Send content to a chat tab */
  onSendToChat?: (content: string) => void;
  /** Available chat tab names for display */
  chatTabNames?: string[];
}

export function NotesView({ visible, data, onUpdateData, onClose, onSendToChat, chatTabNames = [] }: NotesViewProps) {
  const [notes, setNotes] = useState<NoteEntry[]>(() => {
    const fromFile = loadNotes();
    if (fromFile.length > 0) return fromFile;
    const fromProps = data.notes as NoteEntry[] | undefined;
    return fromProps || [];
  });
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [mode, setMode] = useState<Mode>("list");
  const [inputBuffer, setInputBuffer] = useState("");

  // Persist whenever notes change
  const updateNotes = useCallback((updated: NoteEntry[]) => {
    setNotes(updated);
    saveNotes(updated);
    onUpdateData({ notes: updated });
  }, [onUpdateData]);

  // Clamp selectedIndex
  useEffect(() => {
    if (selectedIndex >= notes.length && notes.length > 0) {
      setSelectedIndex(notes.length - 1);
    }
    if (notes.length === 0) setSelectedIndex(0);
  }, [notes.length, selectedIndex]);

  // Reset input state when view becomes hidden
  useEffect(() => {
    if (!visible && mode !== "list") {
      setMode("list");
      setInputBuffer("");
    }
  }, [visible]);

  useInput((input, key) => {

    // --- ADD mode: typing a new note ---
    if (mode === "add") {
      if (key.return) {
        if (inputBuffer.trim()) {
          const lines = inputBuffer.trim().split("\\n");
          const title = lines[0] || "Untitled";
          const now = new Date().toISOString();
          const newNote: NoteEntry = {
            id: `note-${Date.now()}`,
            title,
            content: inputBuffer.trim(),
            createdAt: now,
            updatedAt: now,
          };
          const updated = [...notes, newNote];
          updateNotes(updated);
          setSelectedIndex(updated.length - 1);
        }
        setInputBuffer("");
        setMode("list");
        return;
      }
      if (key.escape) {
        setInputBuffer("");
        setMode("list");
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

    // --- EDIT mode: editing existing note content ---
    if (mode === "edit") {
      if (key.escape) {
        // Save edits and return to view
        if (notes[selectedIndex]) {
          const updated = notes.map((n, i) =>
            i === selectedIndex
              ? {
                  ...n,
                  content: inputBuffer,
                  title: inputBuffer.split("\n")[0] || inputBuffer.split("\\n")[0] || n.title,
                  updatedAt: new Date().toISOString(),
                }
              : n
          );
          updateNotes(updated);
        }
        setInputBuffer("");
        setMode("view");
        return;
      }
      if (key.backspace || key.delete) {
        setInputBuffer((prev) => prev.slice(0, -1));
        return;
      }
      if (key.return) {
        setInputBuffer((prev) => prev + "\n");
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        setInputBuffer((prev) => prev + input);
        return;
      }
      return;
    }

    // --- VIEW mode: viewing a single note ---
    if (mode === "view") {
      if (key.escape || input === "q") {
        setMode("list");
        return;
      }
      if (input === "e") {
        setInputBuffer(notes[selectedIndex]?.content || "");
        setMode("edit");
        return;
      }
      return;
    }

    // --- LIST mode: navigating notes ---
    if (key.upArrow) {
      setSelectedIndex((prev) => Math.max(0, prev - 1));
    } else if (key.downArrow) {
      setSelectedIndex((prev) => Math.min(notes.length - 1, prev + 1));
    } else if (key.return && notes.length > 0) {
      setMode("view");
    } else if (input === "a" || input === "n") {
      setInputBuffer("");
      setMode("add");
    } else if ((input === "d") && notes.length > 0) {
      const updated = notes.filter((_, i) => i !== selectedIndex);
      updateNotes(updated);
    } else if (key.ctrl && input === "d") {
      // Ctrl+D: clear all notes
      updateNotes([]);
    } else if (input === "s" && notes.length > 0 && onSendToChat) {
      // Send selected note content to active chat tab
      const note = notes[selectedIndex];
      if (note) {
        onSendToChat(note.content);
      }
    } else if (key.escape || input === "q") {
      onClose();
    }
  }, { isActive: visible });

  if (!visible) return null;

  const lastModified = notes.length > 0
    ? new Date(Math.max(...notes.map((n) => new Date(n.updatedAt).getTime())))
    : null;

  // --- VIEW mode render ---
  if (mode === "view" && notes[selectedIndex]) {
    const note = notes[selectedIndex];
    return (
      <Box flexDirection="column" paddingX={1}>
        <Box marginBottom={1}>
          <Heading>Notes</Heading>
          <MutedText>  Viewing: {note.title}</MutedText>
        </Box>
        <Divider />
        <Box flexDirection="column" paddingY={1}>
          <Text bold color="cyan">{note.title}</Text>
          <Box marginTop={1}>
            <AppText>{note.content}</AppText>
          </Box>
          <Box marginTop={1}>
            <MutedText>
              Created: {new Date(note.createdAt).toLocaleString()} | Updated: {new Date(note.updatedAt).toLocaleString()}
            </MutedText>
          </Box>
        </Box>
        <Divider />
        <MutedText>e=edit  ESC=back to list</MutedText>
      </Box>
    );
  }

  // --- EDIT mode render ---
  if (mode === "edit" && notes[selectedIndex]) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Box marginBottom={1}>
          <Heading>Notes</Heading>
          <MutedText>  Editing: {notes[selectedIndex].title}</MutedText>
        </Box>
        <Divider />
        <Box flexDirection="column" paddingY={1}>
          <AppText>{inputBuffer}</AppText>
          <Text color="cyan">_</Text>
        </Box>
        <Divider />
        <MutedText>Type to edit. Enter=newline  ESC=save and back</MutedText>
      </Box>
    );
  }

  // --- LIST mode render ---
  return (
    <Box flexDirection="column" paddingX={1}>
      <Box marginBottom={1}>
        <Heading>Notes</Heading>
        <MutedText>
          {"  "}Scratchpad — {notes.length} note{notes.length !== 1 ? "s" : ""}
          {lastModified ? ` | last modified ${lastModified.toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}` : ""}
        </MutedText>
      </Box>

      <Divider />

      {mode === "add" ? (
        <Box marginY={1}>
          <Text color="cyan" bold>{">> "}</Text>
          <AppText>{inputBuffer}</AppText>
          <Text color="cyan">_</Text>
        </Box>
      ) : null}

      {notes.length === 0 && mode !== "add" ? (
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
              <AppText bold={i === selectedIndex}>{note.title}</AppText>
              <Box flexGrow={1} />
              <MutedText>
                {note.content.split("\n").length} line{note.content.split("\n").length !== 1 ? "s" : ""}
                {"  "}
                {new Date(note.updatedAt).toLocaleDateString("en-US", {
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
        a=add  d=delete  s=send to chat  Enter=view  arrows=navigate  ESC=back
      </MutedText>
    </Box>
  );
}
