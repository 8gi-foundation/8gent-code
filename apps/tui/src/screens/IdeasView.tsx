/**
 * 8gent Code - Ideas View
 *
 * Capture ideas with optional tags. Persists to tab data.
 */

import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { AppText, MutedText, Heading, Stack, Divider, Badge } from "../components/primitives/index.js";

interface IdeaEntry {
  id: string;
  text: string;
  tags: string[];
  createdAt: string;
}

interface IdeasViewProps {
  visible: boolean;
  data: Record<string, unknown>;
  onUpdateData: (data: Record<string, unknown>) => void;
  onClose: () => void;
}

export function IdeasView({ visible, data, onUpdateData, onClose }: IdeasViewProps) {
  const ideas: IdeaEntry[] = (data.ideas as IdeaEntry[]) || [];
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [inputMode, setInputMode] = useState<"idea" | "tag" | null>(null);
  const [inputBuffer, setInputBuffer] = useState("");

  useInput((input, key) => {
    if (!visible) return;

    if (inputMode) {
      if (key.return) {
        if (inputMode === "idea" && inputBuffer.trim()) {
          // Parse tags from text: "my idea #tag1 #tag2"
          const parts = inputBuffer.trim().split(/\s+/);
          const tags: string[] = [];
          const textParts: string[] = [];
          for (const part of parts) {
            if (part.startsWith("#") && part.length > 1) {
              tags.push(part.slice(1));
            } else {
              textParts.push(part);
            }
          }
          const newIdea: IdeaEntry = {
            id: `idea-${Date.now()}`,
            text: textParts.join(" "),
            tags,
            createdAt: new Date().toISOString(),
          };
          const updated = [...ideas, newIdea];
          onUpdateData({ ideas: updated });
          setSelectedIndex(updated.length - 1);
        } else if (inputMode === "tag" && inputBuffer.trim() && ideas.length > 0) {
          const tag = inputBuffer.trim().replace(/^#/, "");
          const updated = ideas.map((idea, i) =>
            i === selectedIndex
              ? { ...idea, tags: [...idea.tags, tag] }
              : idea
          );
          onUpdateData({ ideas: updated });
        }
        setInputBuffer("");
        setInputMode(null);
        return;
      }
      if (key.escape) {
        setInputBuffer("");
        setInputMode(null);
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
    if (key.downArrow) setSelectedIndex((prev) => Math.min(ideas.length - 1, prev + 1));
    if (input === "a" || input === "n") {
      setInputMode("idea");
      setInputBuffer("");
    }
    if (input === "t" && ideas.length > 0) {
      setInputMode("tag");
      setInputBuffer("");
    }
    if ((input === "d" || key.delete) && ideas.length > 0) {
      const updated = ideas.filter((_, i) => i !== selectedIndex);
      onUpdateData({ ideas: updated });
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
        <Heading>Ideas</Heading>
        <MutedText>  Idea capture — {ideas.length} idea{ideas.length !== 1 ? "s" : ""}</MutedText>
      </Box>

      <Divider />

      {inputMode === "idea" && (
        <Box marginY={1}>
          <Text color="yellow" bold>{"idea: "}</Text>
          <AppText>{inputBuffer}</AppText>
          <Text color="cyan">_</Text>
          <MutedText>  (use #tag to add tags)</MutedText>
        </Box>
      )}

      {inputMode === "tag" && (
        <Box marginY={1}>
          <Text color="magenta" bold>{"tag: "}</Text>
          <AppText>{inputBuffer}</AppText>
          <Text color="cyan">_</Text>
        </Box>
      )}

      {ideas.length === 0 && !inputMode ? (
        <Box paddingY={1}>
          <MutedText>No ideas yet. Press [a] to add one. Use #tag for tags.</MutedText>
        </Box>
      ) : (
        <Stack>
          {ideas.map((idea, i) => (
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
            </Box>
          ))}
        </Stack>
      )}

      <Box marginTop={1}>
        <Divider />
      </Box>
      <MutedText>
        a=add idea  t=tag selected  d=delete  arrows=navigate  ESC=back
      </MutedText>
    </Box>
  );
}
