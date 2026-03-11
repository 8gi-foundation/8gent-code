/**
 * 8gent Code - Ghost Text Suggestion Component
 *
 * Shows dimmed gray text after cursor as a suggestion.
 * Press Tab to accept the full suggestion.
 *
 * Features:
 * - Inline ghost text rendering
 * - Tab to accept
 * - Escape to dismiss
 * - Source indicator (plan, history, context)
 */

import React, { useState, useEffect, useCallback } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import Spinner from "ink-spinner";
import {
  useGhostSuggestion,
  GhostSuggestion,
  SuggestionSource,
  getSuggestionSourceLabel,
} from "../hooks/use-ghost-suggestion.js";

// ============================================
// Types
// ============================================

export interface GhostInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  placeholder?: string;
  isProcessing?: boolean;
  // Ghost suggestion options
  isGitRepo?: boolean;
  currentBranch?: string | null;
  planNextStep?: string | null;
  recentCommands?: string[];
  showSourceHint?: boolean;
}

// ============================================
// Ghost Input Component
// ============================================

export function GhostInput({
  value,
  onChange,
  onSubmit,
  placeholder = "Type a command or ask a question...",
  isProcessing = false,
  isGitRepo = false,
  currentBranch = null,
  planNextStep = null,
  recentCommands = [],
  showSourceHint = true,
}: GhostInputProps) {
  const { suggestion, accept, dismiss, isVisible } = useGhostSuggestion(value, {
    isGitRepo,
    currentBranch,
    planNextStep,
    recentCommands,
  });

  // Handle keyboard input
  useInput((input, key) => {
    // Tab to accept suggestion
    if (key.tab && isVisible && suggestion) {
      const newValue = accept();
      onChange(newValue);
      return;
    }

    // Escape to dismiss
    if (key.escape && isVisible) {
      dismiss();
      return;
    }
  });

  if (isProcessing) {
    return (
      <Box>
        <Text color="cyan">
          <Spinner type="dots" />
        </Text>
        <Text color="gray"> Processing...</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Box>
        <Text color="cyan" bold>
          {"\u276F"}{" "}
        </Text>
        {/* Main input area with ghost text overlay */}
        <Box>
          <Text>{value}</Text>
          {isVisible && suggestion && (
            <Text color="gray" dimColor>
              {suggestion.text}
            </Text>
          )}
          {!value && !isVisible && (
            <Text color="gray" dimColor>
              {placeholder}
            </Text>
          )}
          {/* Cursor indicator */}
          <Text color="cyan">{"\u2588"}</Text>
        </Box>
      </Box>

      {/* Source hint */}
      {showSourceHint && isVisible && suggestion && (
        <Box paddingLeft={2} marginTop={0}>
          <Text color="gray" dimColor>
            <Text color="gray">[Tab]</Text> {getSuggestionSourceLabel(suggestion.source)}
            {suggestion.source === "history" && suggestion.metadata?.frequency && (
              <Text color="gray"> (used {suggestion.metadata.frequency as number}x)</Text>
            )}
          </Text>
        </Box>
      )}
    </Box>
  );
}

// ============================================
// Standalone Ghost Text Component
// ============================================

export interface GhostTextProps {
  suggestion: GhostSuggestion | null;
  animate?: boolean;
}

export function GhostText({ suggestion, animate = true }: GhostTextProps) {
  const [opacity, setOpacity] = useState(0);

  useEffect(() => {
    if (suggestion && animate) {
      // Fade in effect
      const timeout = setTimeout(() => setOpacity(1), 50);
      return () => clearTimeout(timeout);
    } else {
      setOpacity(0);
    }
  }, [suggestion, animate]);

  if (!suggestion) return null;

  return (
    <Text color="gray" dimColor={opacity < 1}>
      {suggestion.text}
    </Text>
  );
}

// ============================================
// Full Command Input with Ghost Suggestions
// ============================================

export interface GhostCommandInputProps {
  onSubmit: (input: string) => void;
  isProcessing: boolean;
  isGitRepo?: boolean;
  currentBranch?: string | null;
  planNextStep?: string | null;
  recentCommands?: string[];
}

export function GhostCommandInput({
  onSubmit,
  isProcessing,
  isGitRepo = false,
  currentBranch = null,
  planNextStep = null,
  recentCommands = [],
}: GhostCommandInputProps) {
  const [value, setValue] = useState("");

  const handleSubmit = useCallback(
    (input: string) => {
      if (input.trim()) {
        onSubmit(input);
        setValue("");
      }
    },
    [onSubmit]
  );

  const handleChange = useCallback((newValue: string) => {
    setValue(newValue);
  }, []);

  const { suggestion, accept, dismiss, isVisible } = useGhostSuggestion(value, {
    isGitRepo,
    currentBranch,
    planNextStep,
    recentCommands,
  });

  // Handle keyboard input for ghost suggestions
  useInput(
    (input, key) => {
      // Tab to accept suggestion
      if (key.tab && isVisible && suggestion) {
        const newValue = accept();
        setValue(newValue);
        return;
      }

      // Escape to dismiss
      if (key.escape && isVisible) {
        dismiss();
        return;
      }

      // Enter to submit (handled by TextInput)
    },
    { isActive: !isProcessing }
  );

  if (isProcessing) {
    return (
      <Box paddingX={1}>
        <Text color="cyan">
          <Spinner type="dots" />
        </Text>
        <Text color="gray"> Processing...</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box>
        <Text color="cyan" bold>
          {"\u276F"}{" "}
        </Text>
        <Box>
          <TextInput
            value={value}
            onChange={handleChange}
            onSubmit={handleSubmit}
            placeholder={isVisible ? "" : "Type a command or ask a question..."}
          />
          {/* Ghost text overlay */}
          {isVisible && suggestion && (
            <Text color="gray" dimColor>
              {suggestion.text}
            </Text>
          )}
        </Box>
      </Box>

      {/* Tab hint */}
      {isVisible && suggestion && (
        <Box paddingLeft={2}>
          <Text color="gray" dimColor>
            <Text color="blue">[Tab]</Text> to accept{" "}
            <Text color="gray">({getSuggestionSourceLabel(suggestion.source)})</Text>
          </Text>
        </Box>
      )}
    </Box>
  );
}

// ============================================
// Suggestion Preview Component
// ============================================

export interface SuggestionPreviewProps {
  suggestions: GhostSuggestion[];
  maxItems?: number;
}

export function SuggestionPreview({
  suggestions,
  maxItems = 3,
}: SuggestionPreviewProps) {
  if (suggestions.length === 0) return null;

  return (
    <Box flexDirection="column" paddingX={1} marginTop={1}>
      <Text color="gray" dimColor>
        Suggestions:
      </Text>
      {suggestions.slice(0, maxItems).map((s, i) => (
        <Box key={i} paddingLeft={1}>
          <Text color="gray">
            {"\u2022"} {s.text}
          </Text>
          <Text color="gray" dimColor>
            {" "}
            ({getSuggestionSourceLabel(s.source)})
          </Text>
        </Box>
      ))}
    </Box>
  );
}

// ============================================
// Source Icon Component
// ============================================

interface SourceIconProps {
  source: SuggestionSource;
}

export function SourceIcon({ source }: SourceIconProps) {
  const icons: Record<SuggestionSource, { icon: string; color: string }> = {
    plan: { icon: "\u25B6", color: "green" },    // Play icon for plan
    history: { icon: "\u21BA", color: "yellow" }, // Cycle icon for history
    context: { icon: "\u2699", color: "cyan" },   // Gear for context
    ai: { icon: "\u2605", color: "magenta" },     // Star for AI
  };

  const { icon, color } = icons[source] || { icon: "?", color: "gray" };

  return <Text color={color as any}>{icon}</Text>;
}
