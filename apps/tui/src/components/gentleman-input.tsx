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
import { AppText, MutedText, Label, ShortcutHint, Inline, Stack, Divider, Badge } from './primitives/index.js';

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

  const lineWidth = Math.max(40, width - 4);

  return (
    <Stack paddingX={1}>
      {/* ═══════ TOP LINE ═══════ */}
      <Divider width={lineWidth} />

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
          <Inline gap={0}>
            <ShortcutHint keys="Tab" description="to accept" />
            <MutedText> · </MutedText>
            <MutedText>{getSuggestionSourceLabel(suggestion.source)}</MutedText>
          </Inline>
        </Box>
      )}

      {/* ═══════ BOTTOM LINE WITH STATUS ═══════ */}
      <Divider width={lineWidth} />

      {/* ═══════ STATUS INDICATORS ═══════ */}
      <StatusLine
        modelName={modelName}
        tokensSaved={tokensSaved}
        elapsed={elapsed}
        permissionMode={permissionMode}
        currentBranch={currentBranch}
        isProcessing={isProcessing}
      />
    </Stack>
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
    <Inline gap={0}>
      {/* Animated prompt */}
      <Label color={colors[promptColor] as string}>
        ❯{" "}
      </Label>

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
          <MutedText>
            {suggestion.text}
          </MutedText>
        )}

        {/* Placeholder when empty */}
        {!value && !isVisible && (
          <MutedText>
            What would you like to build?
          </MutedText>
        )}
      </Box>
    </Inline>
  );
}

interface ProcessingIndicatorProps {
  status: string;
}

function ProcessingIndicator({ status }: ProcessingIndicatorProps) {
  return (
    <Inline gap={0}>
      <Text color="cyan">
        <Spinner type="dots" />
      </Text>
      <AppText color="cyan"> {status}</AppText>
    </Inline>
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
    <Inline paddingTop={1}>
      {/* Model */}
      <Badge label={modelName} color="cyan" variant="outline" />
      <MutedText>·</MutedText>

      {/* Tokens saved */}
      <AppText color="green">↓{formatTokens(tokensSaved)}</AppText>
      <MutedText>·</MutedText>

      {/* Permission mode */}
      <AppText color={permColors[permissionMode]}>
        {permIcons[permissionMode]}
      </AppText>
      <MutedText>·</MutedText>

      {/* Git branch */}
      {currentBranch && (
        <>
          <AppText color="yellow">{currentBranch}</AppText>
          <MutedText>·</MutedText>
        </>
      )}

      {/* Elapsed */}
      <MutedText>
        {elapsed}
      </MutedText>

      {/* Processing indicator */}
      {isProcessing && (
        <>
          <MutedText>·</MutedText>
          <Text color="cyan">
            <Spinner type="dots" />
          </Text>
        </>
      )}
    </Inline>
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
    <Stack paddingX={1}>
      <Divider width={60} />
      <Box paddingY={1}>
        {isProcessing ? (
          <Inline gap={0}>
            <Text color="cyan">
              <Spinner type="dots" />
            </Text>
            <MutedText> Working...</MutedText>
          </Inline>
        ) : (
          <Inline gap={0}>
            <Label color="cyan">
              ❯{" "}
            </Label>
            <TextInput
              value={value}
              onChange={setValue}
              onSubmit={handleSubmit}
              placeholder="What would you like to build?"
            />
          </Inline>
        )}
      </Box>
      <Divider width={60} />
    </Stack>
  );
}
