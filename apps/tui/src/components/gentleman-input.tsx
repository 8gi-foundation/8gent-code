/**
 * 8gent Code - Gentleman Input Component
 *
 * The Infinite Gentleman's input interface.
 * Features:
 * - Horizontal line above input
 * - Horizontal line below with status indicators
 * - Ghost text suggestions (Tab to accept)
 * - Animated prompt indicator
 * - Status bar integrated below
 */

import React, { useState, useEffect, useCallback } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import Spinner from "ink-spinner";
import {
  useGhostSuggestion,
  getSuggestionSourceLabel,
} from "../hooks/use-ghost-suggestion.js";

// ============================================
// Types
// ============================================

export interface GentlemanInputProps {
  onSubmit: (input: string) => void;
  isProcessing: boolean;
  processingStatus?: string;
  // Ghost suggestion context
  isGitRepo?: boolean;
  currentBranch?: string | null;
  planNextStep?: string | null;
  recentCommands?: string[];
  // Status bar items
  modelName?: string;
  tokensSaved?: number;
  elapsed?: string;
  permissionMode?: "full" | "ask" | "restricted";
  // Display
  width?: number;
}

// ============================================
// Main Component
// ============================================

export function GentlemanInput({
  onSubmit,
  isProcessing,
  processingStatus = "Processing...",
  isGitRepo = false,
  currentBranch = null,
  planNextStep = null,
  recentCommands = [],
  modelName = "8gent",
  tokensSaved = 0,
  elapsed = "0:00",
  permissionMode = "ask",
  width = 80,
}: GentlemanInputProps) {
  const [value, setValue] = useState("");

  // Ghost suggestion
  const { suggestion, accept, dismiss, isVisible } = useGhostSuggestion(value, {
    isGitRepo,
    currentBranch,
    planNextStep,
    recentCommands,
  });

  // Handle Tab to accept
  useInput(
    (input, key) => {
      if (key.tab && isVisible && suggestion) {
        const newValue = accept();
        setValue(newValue);
        return;
      }
      if (key.escape && isVisible) {
        dismiss();
        return;
      }
    },
    { isActive: !isProcessing }
  );

  const handleSubmit = useCallback(
    (input: string) => {
      if (!input.trim()) return;
      onSubmit(input);
      setValue("");
    },
    [onSubmit]
  );

  const lineChar = "─";
  const lineWidth = Math.max(40, width - 4);

  return (
    <Box flexDirection="column" paddingX={1}>
      {/* ═══════ TOP LINE ═══════ */}
      <Box>
        <Text dimColor>{lineChar.repeat(lineWidth)}</Text>
      </Box>

      {/* ═══════ INPUT AREA ═══════ */}
      <Box paddingY={1}>
        {isProcessing ? (
          <ProcessingIndicator status={processingStatus} />
        ) : (
          <InputWithGhost
            value={value}
            onChange={setValue}
            onSubmit={handleSubmit}
            suggestion={suggestion}
            isVisible={isVisible}
          />
        )}
      </Box>

      {/* ═══════ GHOST HINT (below input) ═══════ */}
      {!isProcessing && isVisible && suggestion && (
        <Box paddingLeft={3} marginBottom={1}>
          <Text dimColor>
            <Text color="blue">Tab</Text> to accept
            <Text dimColor> · </Text>
            <Text dimColor>{getSuggestionSourceLabel(suggestion.source)}</Text>
          </Text>
        </Box>
      )}

      {/* ═══════ BOTTOM LINE WITH STATUS ═══════ */}
      <Box>
        <Text dimColor>{lineChar.repeat(lineWidth)}</Text>
      </Box>

      {/* ═══════ STATUS INDICATORS ═══════ */}
      <StatusLine
        modelName={modelName}
        tokensSaved={tokensSaved}
        elapsed={elapsed}
        permissionMode={permissionMode}
        currentBranch={currentBranch}
        isProcessing={isProcessing}
      />
    </Box>
  );
}

// ============================================
// Sub-Components
// ============================================

interface InputWithGhostProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  suggestion: { text: string; source: string } | null;
  isVisible: boolean;
}

function InputWithGhost({
  value,
  onChange,
  onSubmit,
  suggestion,
  isVisible,
}: InputWithGhostProps) {
  const [promptColor, setPromptColor] = useState(0);
  const colors = ["cyan", "blue", "magenta", "cyan"] as const;

  // Animate prompt color
  useEffect(() => {
    const interval = setInterval(() => {
      setPromptColor((p) => (p + 1) % colors.length);
    }, 400);
    return () => clearInterval(interval);
  }, []);

  return (
    <Box>
      {/* Animated prompt */}
      <Text color={colors[promptColor]} bold>
        ❯{" "}
      </Text>

      {/* Input field */}
      <Box flexGrow={1}>
        <TextInput
          value={value}
          onChange={onChange}
          onSubmit={onSubmit}
          placeholder=""
        />

        {/* Ghost text (after cursor) */}
        {isVisible && suggestion && (
          <Text dimColor>
            {suggestion.text}
          </Text>
        )}

        {/* Placeholder when empty */}
        {!value && !isVisible && (
          <Text dimColor>
            What would you like to build?
          </Text>
        )}
      </Box>
    </Box>
  );
}

interface ProcessingIndicatorProps {
  status: string;
}

function ProcessingIndicator({ status }: ProcessingIndicatorProps) {
  return (
    <Box>
      <Text color="cyan">
        <Spinner type="dots" />
      </Text>
      <Text color="cyan"> {status}</Text>
    </Box>
  );
}

interface StatusLineProps {
  modelName: string;
  tokensSaved: number;
  elapsed: string;
  permissionMode: "full" | "ask" | "restricted";
  currentBranch: string | null;
  isProcessing: boolean;
}

function StatusLine({
  modelName,
  tokensSaved,
  elapsed,
  permissionMode,
  currentBranch,
  isProcessing,
}: StatusLineProps) {
  const permColors = {
    full: "red",
    ask: "yellow",
    restricted: "green",
  } as const;

  const permIcons = {
    full: "⚠",
    ask: "?",
    restricted: "✓",
  };

  return (
    <Box paddingTop={1} gap={1}>
      {/* Model */}
      <Text color="cyan">{modelName}</Text>
      <Text dimColor>·</Text>

      {/* Tokens saved */}
      <Text color="green">↓{formatTokens(tokensSaved)}</Text>
      <Text dimColor>·</Text>

      {/* Permission mode */}
      <Text color={permColors[permissionMode]}>
        {permIcons[permissionMode]}
      </Text>
      <Text dimColor>·</Text>

      {/* Git branch */}
      {currentBranch && (
        <>
          <Text color="yellow">{currentBranch}</Text>
          <Text dimColor>·</Text>
        </>
      )}

      {/* Elapsed */}
      <Text dimColor>
        {elapsed}
      </Text>

      {/* Processing indicator */}
      {isProcessing && (
        <>
          <Text dimColor>·</Text>
          <Text color="cyan">
            <Spinner type="dots" />
          </Text>
        </>
      )}
    </Box>
  );
}

function formatTokens(n: number): string {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
  if (n >= 1000) return (n / 1000).toFixed(1) + "K";
  return n.toString();
}

// ============================================
// Minimal Version
// ============================================

export function GentlemanInputMinimal({
  onSubmit,
  isProcessing,
}: {
  onSubmit: (input: string) => void;
  isProcessing: boolean;
}) {
  const [value, setValue] = useState("");

  const handleSubmit = (input: string) => {
    if (input.trim()) {
      onSubmit(input);
      setValue("");
    }
  };

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box>
        <Text dimColor>{"─".repeat(60)}</Text>
      </Box>
      <Box paddingY={1}>
        {isProcessing ? (
          <Box>
            <Text color="cyan">
              <Spinner type="dots" />
            </Text>
            <Text dimColor> Working...</Text>
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
              placeholder="What would you like to build?"
            />
          </Box>
        )}
      </Box>
      <Box>
        <Text dimColor>{"─".repeat(60)}</Text>
      </Box>
    </Box>
  );
}
