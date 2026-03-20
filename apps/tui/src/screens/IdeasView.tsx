/**
 * 8gent Code - Ideas View
 *
 * Capture ideas with inline #hashtag support. Filter by tag.
 * Data persists to ~/.8gent/tabs/ideas.json
 */

import React, { useState, useEffect, useCallback } from "react";
import { Box, Text, useInput } from "ink";
import { AppText, MutedText, Heading, Stack, Divider, Badge } from "../components/primitives/index.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

const DATA_DIR = join(process.env.HOME || "~", ".8gent", "tabs");

interface IdeaEntry {
  id: string;
  text: string;
  tags: string[];
  createdAt: string;
}

interface IdeasData {
  ideas: IdeaEntry[];
}

function loadIdeas(): IdeaEntry[] {
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    const filepath = join(DATA_DIR, "ideas.json");
    if (existsSync(filepath)) {
      const raw = JSON.parse(readFileSync(filepath, "utf-8")) as IdeasData;
      return raw.ideas || [];
    }
  } catch {}
  return [];
}

function saveIdeas(ideas: IdeaEntry[]): void {
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(join(DATA_DIR, "ideas.json"), JSON.stringify({ ideas }, null, 2));
  } catch {}
}

function extractTags(text: string): { cleanText: string; tags: string[] } {
  const parts = text.split(/\s+/);
  const tags: string[] = [];
  const textParts: string[] = [];
  for (const part of parts) {
    if (part.startsWith("#") && part.length > 1) {
      tags.push(part.slice(1).toLowerCase());
    } else {
      textParts.push(part);
    }
  }
  return { cleanText: textParts.join(" "), tags };
}

type Mode = "list" | "add" | "filter";

interface IdeasViewProps {
  visible: boolean;
  data: Record<string, unknown>;
  onUpdateData: (data: Record<string, unknown>) => void;
  onClose: () => void;
}

export function IdeasView({ visible, data, onUpdateData, onClose }: IdeasViewProps) {
  const [ideas, setIdeas] = useState<IdeaEntry[]>(() => {
    const fromFile = loadIdeas();
    if (fromFile.length > 0) return fromFile;
    const fromProps = data.ideas as IdeaEntry[] | undefined;
    return fromProps || [];
  });
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [mode, setMode] = useState<Mode>("list");
  const [inputBuffer, setInputBuffer] = useState("");
  const [filterTag, setFilterTag] = useState<string | null>(null);

  const updateIdeas = useCallback((updated: IdeaEntry[]) => {
    setIdeas(updated);
    saveIdeas(updated);
    onUpdateData({ ideas: updated });
  }, [onUpdateData]);

  // Filtered list
  const filtered = filterTag
    ? ideas.filter((idea) => idea.tags.includes(filterTag))
    : ideas;

  // All unique tags
  const allTags = Array.from(new Set(ideas.flatMap((i) => i.tags))).sort();

  // Clamp selectedIndex
  useEffect(() => {
    if (selectedIndex >= filtered.length && filtered.length > 0) {
      setSelectedIndex(filtered.length - 1);
    }
    if (filtered.length === 0) setSelectedIndex(0);
  }, [filtered.length, selectedIndex]);

  useEffect(() => {
    if (!visible) { setMode("list"); setInputBuffer(""); }
  }, [visible]);

  useInput((input, key) => {
    // --- ADD mode ---
    if (mode === "add") {
      if (key.return) {
        if (inputBuffer.trim()) {
          const { cleanText, tags } = extractTags(inputBuffer.trim());
          const newIdea: IdeaEntry = {
            id: `idea-${Date.now()}`,
            text: cleanText || inputBuffer.trim(),
            tags,
            createdAt: new Date().toISOString(),
          };
          const updated = [...ideas, newIdea];
          updateIdeas(updated);
          setSelectedIndex(filtered.length); // will clamp
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

    // --- FILTER mode ---
    if (mode === "filter") {
      if (key.return) {
        const tag = inputBuffer.trim().replace(/^#/, "").toLowerCase();
        if (tag) {
          setFilterTag(tag);
          setSelectedIndex(0);
        } else {
          setFilterTag(null);
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

    // --- LIST mode ---
    if (key.upArrow) {
      setSelectedIndex((prev) => Math.max(0, prev - 1));
    } else if (key.downArrow) {
      setSelectedIndex((prev) => Math.min(filtered.length - 1, prev + 1));
    } else if (input === "a" || input === "n") {
      setInputBuffer("");
      setMode("add");
    } else if (input === "f") {
      setInputBuffer("");
      setMode("filter");
    } else if (input === "c" && filterTag) {
      // Clear filter
      setFilterTag(null);
      setSelectedIndex(0);
    } else if ((input === "d") && filtered.length > 0) {
      const ideaToDelete = filtered[selectedIndex];
      if (ideaToDelete) {
        const updated = ideas.filter((i) => i.id !== ideaToDelete.id);
        updateIdeas(updated);
      }
    } else if (input === "t" && filtered.length > 0 && filtered[selectedIndex]) {
      // Quick tag add: enter add mode but pre-fill with idea text + space for tag
      setInputBuffer("");
      setMode("add");
    } else if (key.escape || input === "q") {
      if (filterTag) {
        setFilterTag(null);
        setSelectedIndex(0);
      } else {
        onClose();
      }
    }
  }, { isActive: visible });

  if (!visible) return null;

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box marginBottom={1}>
        <Heading>Ideas</Heading>
        <MutedText>
          {"  "}Idea capture — {ideas.length} idea{ideas.length !== 1 ? "s" : ""}
          {filterTag ? ` | filtered: #${filterTag} (${filtered.length} match${filtered.length !== 1 ? "es" : ""})` : ""}
        </MutedText>
      </Box>

      <Divider />

      {/* Tag bar */}
      {allTags.length > 0 && (
        <Box marginY={1} flexWrap="wrap">
          <MutedText>Tags: </MutedText>
          {allTags.map((tag) => (
            <Box key={tag} marginRight={1}>
              <Badge
                label={`#${tag}`}
                color={filterTag === tag ? "cyan" : "magenta"}
                variant={filterTag === tag ? "solid" : "outline"}
              />
            </Box>
          ))}
        </Box>
      )}

      {mode === "add" && (
        <Box marginY={1}>
          <Text color="yellow" bold>{"idea: "}</Text>
          <AppText>{inputBuffer}</AppText>
          <Text color="cyan">_</Text>
          <MutedText>  (use #tag for tags)</MutedText>
        </Box>
      )}

      {mode === "filter" && (
        <Box marginY={1}>
          <Text color="magenta" bold>{"filter by tag: "}</Text>
          <AppText>{inputBuffer}</AppText>
          <Text color="cyan">_</Text>
          <MutedText>  (empty = clear filter)</MutedText>
        </Box>
      )}

      {filtered.length === 0 && mode === "list" ? (
        <Box paddingY={1}>
          <MutedText>
            {filterTag
              ? `No ideas with #${filterTag}. Press [c] to clear filter or [a] to add.`
              : "No ideas yet. Press [a] to add one. Use #tag for tags."}
          </MutedText>
        </Box>
      ) : (
        <Stack>
          {filtered.map((idea, i) => (
            <Box key={idea.id}>
              <Text color={i === selectedIndex ? "cyan" : undefined}>
                {i === selectedIndex ? ">" : " "}{" "}
              </Text>
              <AppText bold={i === selectedIndex}>{idea.text}</AppText>
              {idea.tags.length > 0 && (
                <Box marginLeft={1}>
                  {idea.tags.map((tag) => (
                    <Box key={tag} marginRight={1}>
                      <Badge label={`#${tag}`} color="magenta" variant="outline" />
                    </Box>
                  ))}
                </Box>
              )}
              <Box flexGrow={1} />
              <MutedText>
                {new Date(idea.createdAt).toLocaleDateString("en-US", {
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
        a=add  d=delete  f=filter by tag  {filterTag ? "c=clear filter  " : ""}arrows=navigate  ESC=back
      </MutedText>
    </Box>
  );
}
