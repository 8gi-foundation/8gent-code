import React from "react";
import { Box, Text } from "ink";

export interface NarratorProps {
  text: string;
  maxLines?: number;
}

export function Narrator({ text, maxLines = 2 }: NarratorProps) {
  if (!text) return null;

  return (
    <Box height={maxLines} flexDirection="row">
      <Text>{"💬 "}</Text>
      <Box flexShrink={1}>
        <Text dimColor wrap="truncate-end">
          {text}
        </Text>
      </Box>
    </Box>
  );
}
