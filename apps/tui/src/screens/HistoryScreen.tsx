/**
 * HistoryScreen — Browse and resume past conversations.
 *
 * Shows a selectable list of recent sessions with title, date, model, and message count.
 * Uses design system primitives, follows TUI color rules.
 */

import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import {
  AppText,
  MutedText,
  Heading,
  Stack,
  Inline,
  Divider,
} from "../components/primitives/index.js";

interface ConversationEntry {
  _id: string;
  sessionId: string;
  title: string;
  summary?: string;
  messageCount: number;
  model: string;
  workingDirectory: string;
  gitBranch?: string;
  startedAt: number;
  lastActiveAt: number;
}

interface HistoryScreenProps {
  conversations: ConversationEntry[];
  onSelect: (conversation: ConversationEntry) => void;
  onBack: () => void;
}

function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

export function HistoryScreen({
  conversations,
  onSelect,
  onBack,
}: HistoryScreenProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);

  useInput((input, key) => {
    if (key.upArrow) {
      setSelectedIndex((prev) => Math.max(0, prev - 1));
    } else if (key.downArrow) {
      setSelectedIndex((prev) =>
        Math.min(conversations.length - 1, prev + 1)
      );
    } else if (key.return) {
      if (conversations[selectedIndex]) {
        onSelect(conversations[selectedIndex]);
      }
    } else if (key.escape || input === "q") {
      onBack();
    }
  });

  if (conversations.length === 0) {
    return (
      <Stack>
        <Heading>Session History</Heading>
        <MutedText>No previous sessions found.</MutedText>
        <MutedText>Start chatting and your sessions will appear here.</MutedText>
        <MutedText dimColor>Press Escape to go back</MutedText>
      </Stack>
    );
  }

  return (
    <Stack>
      <Inline>
        <Heading>Session History</Heading>
        <MutedText> ({conversations.length} sessions)</MutedText>
      </Inline>
      <MutedText>Up/Down Navigate - Enter to resume - Esc to go back</MutedText>
      <Divider />

      {conversations.map((conv, index) => {
        const isSelected = index === selectedIndex;
        return (
          <Box
            key={conv._id}
            paddingLeft={1}
            paddingRight={1}
            borderStyle={isSelected ? "round" : undefined}
            borderColor={isSelected ? "cyan" : undefined}
          >
            <Stack>
              <Inline>
                {isSelected ? (
                  <Text color="cyan" bold>
                    {"> "}
                  </Text>
                ) : (
                  <Text>{"  "}</Text>
                )}
                <AppText bold={isSelected}>
                  {conv.title.slice(0, 60)}
                </AppText>
              </Inline>
              <Inline>
                <MutedText>
                  {"    "}
                  {formatRelativeTime(conv.lastActiveAt)} - {conv.model} -{" "}
                  {conv.messageCount} msgs
                  {conv.gitBranch ? ` - ${conv.gitBranch}` : ""}
                </MutedText>
              </Inline>
            </Stack>
          </Box>
        );
      })}
    </Stack>
  );
}

export default HistoryScreen;
