/**
 * 8gent Code - Command Input Component
 */

import React, { useState } from "react";
import { Box, Text } from "ink";
import TextInput from "ink-text-input";
import Spinner from "ink-spinner";

interface CommandInputProps {
  onSubmit: (input: string) => void;
  isProcessing: boolean;
}

export function CommandInput({ onSubmit, isProcessing }: CommandInputProps) {
  const [value, setValue] = useState("");

  const handleSubmit = (input: string) => {
    onSubmit(input);
    setValue("");
  };

  return (
    <Box paddingX={1}>
      {isProcessing ? (
        <Box>
          <Text color="cyan">
            <Spinner type="dots" />
          </Text>
          <Text color="gray"> Processing...</Text>
        </Box>
      ) : (
        <Box>
          <Text color="cyan" bold>
            ❯{" "}
          </Text>
          <TextInput
            value={value}
            onChange={setValue}
            onSubmit={handleSubmit}
            placeholder="Type a command or ask a question..."
          />
        </Box>
      )}
    </Box>
  );
}
