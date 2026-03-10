/**
 * 8gent Code - Status Bar Component
 */

import React from "react";
import { Box, Text } from "ink";

interface StatusBarProps {
  tokensSaved: number;
}

export function StatusBar({ tokensSaved }: StatusBarProps) {
  const formattedTokens = tokensSaved.toLocaleString();

  return (
    <Box
      borderStyle="single"
      borderColor="gray"
      paddingX={1}
      marginTop={1}
      justifyContent="space-between"
    >
      <Box>
        <Text color="green">●</Text>
        <Text color="gray"> AST-first mode</Text>
      </Box>

      <Box>
        <Text color="gray">Tokens saved: </Text>
        <Text color="green" bold>
          {formattedTokens}
        </Text>
      </Box>

      <Box>
        <Text color="gray">Ctrl+C to exit</Text>
      </Box>
    </Box>
  );
}
