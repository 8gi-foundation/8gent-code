/**
 * 8gent Code - Header Component
 */

import React from "react";
import { Box, Text } from "ink";

export function Header() {
  return (
    <Box
      borderStyle="single"
      borderColor="cyan"
      paddingX={1}
      marginBottom={1}
    >
      <Text bold color="cyan">
        8
      </Text>
      <Text bold color="white">
        gent
      </Text>
      <Text color="gray"> Code</Text>
      <Text color="gray"> │ </Text>
      <Text color="gray" dimColor>
        Structured Agentic Development
      </Text>
    </Box>
  );
}
