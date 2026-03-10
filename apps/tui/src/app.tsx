/**
 * 8gent Code - Main App Component
 */

import React, { useState, useEffect } from "react";
import { Box, Text, useInput, useApp } from "ink";
import { Header } from "./components/header.js";
import { StatusBar } from "./components/status-bar.js";
import { CommandInput } from "./components/command-input.js";
import { MessageList } from "./components/message-list.js";

interface AppProps {
  initialCommand: string;
  args: string[];
}

export interface Message {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: Date;
}

export function App({ initialCommand, args }: AppProps) {
  const { exit } = useApp();
  const [messages, setMessages] = useState<Message[]>([
    {
      id: "welcome",
      role: "system",
      content: "8gent Code initialized. Type a command or ask a question.",
      timestamp: new Date(),
    },
  ]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [tokensSaved, setTokensSaved] = useState(0);

  // Handle keyboard shortcuts
  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      exit();
    }
  });

  // Handle command submission
  const handleSubmit = async (input: string) => {
    if (!input.trim()) return;

    // Add user message
    const userMessage: Message = {
      id: `user-${Date.now()}`,
      role: "user",
      content: input,
      timestamp: new Date(),
    };
    setMessages((prev) => [...prev, userMessage]);
    setIsProcessing(true);

    // TODO: Process through planner → toolshed → execution
    // For now, echo back
    setTimeout(() => {
      const assistantMessage: Message = {
        id: `assistant-${Date.now()}`,
        role: "assistant",
        content: `[8gent] Processing: "${input}"\n\nToolshed query → AST retrieval → Execute`,
        timestamp: new Date(),
      };
      setMessages((prev) => [...prev, assistantMessage]);
      setIsProcessing(false);
      setTokensSaved((prev) => prev + Math.floor(Math.random() * 1000));
    }, 500);
  };

  return (
    <Box flexDirection="column" height="100%">
      <Header />

      <Box flexDirection="column" flexGrow={1} paddingX={1}>
        <MessageList messages={messages} />
      </Box>

      <CommandInput
        onSubmit={handleSubmit}
        isProcessing={isProcessing}
      />

      <StatusBar tokensSaved={tokensSaved} />
    </Box>
  );
}
