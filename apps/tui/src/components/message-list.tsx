/**
 * 8gent Code - Message List Component
 */

import React from "react";
import { Box, Text } from "ink";
import type { Message } from "../app.js";

interface MessageListProps {
  messages: Message[];
}

export function MessageList({ messages }: MessageListProps) {
  return (
    <Box flexDirection="column" flexGrow={1}>
      {messages.map((message) => (
        <MessageItem key={message.id} message={message} />
      ))}
    </Box>
  );
}

function MessageItem({ message }: { message: Message }) {
  const roleColors = {
    user: "yellow",
    assistant: "cyan",
    system: "gray",
  } as const;

  const roleLabels = {
    user: "You",
    assistant: "8gent",
    system: "System",
  };

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color={roleColors[message.role]} bold>
          {roleLabels[message.role]}
        </Text>
        <Text color="gray" dimColor>
          {" "}
          {formatTime(message.timestamp)}
        </Text>
      </Box>
      <Box paddingLeft={2}>
        <Text wrap="wrap">{message.content}</Text>
      </Box>
    </Box>
  );
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
  });
}
