/**
 * 8gent Code - Design Selector Component
 *
 * TUI component for displaying design system suggestions
 * and handling user selection.
 *
 * Features:
 * - ASCII previews of design systems
 * - Keyboard navigation (1, 2, 3 or arrow keys)
 * - Stack display
 * - Animated selection
 */

import React, { useState, useEffect, useCallback } from "react";
import { Box, Text, useInput } from "ink";
import { AppText, MutedText, Heading, Label, ErrorText, SuccessText, WarningText, Badge, StatusDot, Card, Stack, Inline, Divider } from './primitives/index.js';
import { truncate } from '../lib/index.js';

// ============================================
// Types
// ============================================

export interface DesignOption {
  id: string;
  name: string;
  description: string;
  reasoning: string;
  score: number;
  stack: string[];
  preview?: {
    type: "ascii" | "colors" | "components";
    content: string;
  };
}

export interface DesignSelectorProps {
  /** Intro message to display */
  intro: string;
  /** Design options to choose from */
  options: DesignOption[];
  /** Currently selected index */
  selectedIndex?: number;
  /** Callback when option is selected */
  onSelect: (option: DesignOption) => void;
  /** Callback when selection is cancelled */
  onCancel?: () => void;
  /** Show keyboard shortcuts */
  showHelp?: boolean;
  /** Component visibility */
  visible?: boolean;
}

export interface DesignSuggestionPanelProps {
  /** Full suggestion result from Design Agent */
  intro: string;
  suggestions: DesignOption[];
  followUp: string;
  onSelect: (option: DesignOption) => void;
  onSkip: () => void;
  visible?: boolean;
}

// ============================================
// Main Selector Component
// ============================================

export function DesignSelector({
  intro,
  options,
  selectedIndex: initialSelected = 0,
  onSelect,
  onCancel,
  showHelp = true,
  visible = true,
}: DesignSelectorProps) {
  const [selectedIndex, setSelectedIndex] = useState(initialSelected);
  const [animationFrame, setAnimationFrame] = useState(0);

  // Animation effect
  useEffect(() => {
    const interval = setInterval(() => {
      setAnimationFrame((prev) => (prev + 1) % 4);
    }, 300);
    return () => clearInterval(interval);
  }, []);

  // Keyboard navigation
  useInput(
    (input, key) => {
      if (!visible) return;

      // Number selection (1, 2, 3)
      const num = parseInt(input, 10);
      if (num >= 1 && num <= options.length) {
        const option = options[num - 1];
        if (option) {
          onSelect(option);
        }
        return;
      }

      // Arrow key navigation
      if (key.downArrow || input === "j") {
        setSelectedIndex((prev) => (prev + 1) % options.length);
        return;
      }

      if (key.upArrow || input === "k") {
        setSelectedIndex((prev) => (prev - 1 + options.length) % options.length);
        return;
      }

      // Enter to select
      if (key.return) {
        const option = options[selectedIndex];
        if (option) {
          onSelect(option);
        }
        return;
      }

      // Escape to cancel
      if (key.escape && onCancel) {
        onCancel();
        return;
      }
    },
    { isActive: visible }
  );

  if (!visible || options.length === 0) return null;

  const pulseChar = ["\u25CF", "\u25D0", "\u25D1", "\u25D0"][animationFrame];

  return (
    <Card borderColor="magenta">
      {/* Header */}
      <Box marginBottom={1}>
        <Label color="magenta">
          {pulseChar} Design Direction
        </Label>
      </Box>

      {/* Intro */}
      <Box marginBottom={1}>
        <Label>{intro}</Label>
      </Box>

      {/* Options */}
      {options.map((option, index) => (
        <DesignOptionCard
          key={option.id}
          option={option}
          index={index + 1}
          isSelected={index === selectedIndex}
        />
      ))}

      {/* Help */}
      {showHelp && (
        <Stack marginTop={1}>
          <MutedText>
            Press [1-{options.length}] to select, or use \u2191\u2193 and Enter
          </MutedText>
          {onCancel && (
            <MutedText>
              Press [ESC] to skip design selection
            </MutedText>
          )}
        </Stack>
      )}
    </Card>
  );
}

// ============================================
// Option Card Component
// ============================================

interface DesignOptionCardProps {
  option: DesignOption;
  index: number;
  isSelected: boolean;
}

function DesignOptionCard({ option, index, isSelected }: DesignOptionCardProps) {
  const borderColor = isSelected ? "cyan" : "blue";
  const borderStyle = isSelected ? "double" : "single";

  return (
    <Box
      flexDirection="column"
      borderStyle={borderStyle as any}
      borderColor={borderColor as any}
      paddingX={1}
      marginBottom={1}
    >
      {/* Title row */}
      <Inline justifyContent="space-between">
        <Inline gap={0}>
          <Badge label={`${index}`} color="yellow" variant="outline" />
          <Label color={isSelected ? "cyan" : undefined}>
            {" "}
            {option.name}
          </Label>
        </Inline>
        <MutedText>
          {Math.round(option.score)}% match
        </MutedText>
      </Inline>

      {/* Description */}
      <Label>{option.description}</Label>

      {/* Reasoning */}
      <Box marginTop={0}>
        <SuccessText italic>
          \u2192 {option.reasoning}
        </SuccessText>
      </Box>

      {/* Stack */}
      <Inline marginTop={0} gap={0}>
        <MutedText>Stack: </MutedText>
        <Text color="cyan">{option.stack.join(" \u2022 ")}</Text>
      </Inline>

      {/* ASCII Preview */}
      {option.preview && (
        <Box marginTop={1}>
          <MutedText>{option.preview.content}</MutedText>
        </Box>
      )}
    </Box>
  );
}

// ============================================
// Full Suggestion Panel
// ============================================

export function DesignSuggestionPanel({
  intro,
  suggestions,
  followUp,
  onSelect,
  onSkip,
  visible = true,
}: DesignSuggestionPanelProps) {
  const [phase, setPhase] = useState<"intro" | "selecting" | "confirming">("intro");
  const [selectedOption, setSelectedOption] = useState<DesignOption | null>(null);

  const handleSelect = useCallback((option: DesignOption) => {
    setSelectedOption(option);
    setPhase("confirming");
  }, []);

  const handleConfirm = useCallback(() => {
    if (selectedOption) {
      onSelect(selectedOption);
    }
  }, [selectedOption, onSelect]);

  const handleBack = useCallback(() => {
    setPhase("selecting");
    setSelectedOption(null);
  }, []);

  // Auto-advance from intro
  useEffect(() => {
    if (phase === "intro") {
      const timer = setTimeout(() => setPhase("selecting"), 100);
      return () => clearTimeout(timer);
    }
  }, [phase]);

  if (!visible) return null;

  // Confirming phase
  if (phase === "confirming" && selectedOption) {
    return (
      <DesignConfirmation
        option={selectedOption}
        onConfirm={handleConfirm}
        onBack={handleBack}
      />
    );
  }

  // Selecting phase
  return (
    <DesignSelector
      intro={intro}
      options={suggestions}
      onSelect={handleSelect}
      onCancel={onSkip}
      showHelp={true}
      visible={true}
    />
  );
}

// ============================================
// Confirmation Component
// ============================================

interface DesignConfirmationProps {
  option: DesignOption;
  onConfirm: () => void;
  onBack: () => void;
}

function DesignConfirmation({ option, onConfirm, onBack }: DesignConfirmationProps) {
  useInput((input, key) => {
    if (key.return || input === "y") {
      onConfirm();
    } else if (key.escape || input === "n") {
      onBack();
    }
  });

  return (
    <Card borderColor="green">
      <Box marginBottom={1}>
        <Label color="green">
          \u2713 Confirm Selection
        </Label>
      </Box>

      <Label>
        You selected: <Heading>{option.name}</Heading>
      </Label>

      <Inline marginTop={1} gap={0}>
        <MutedText>This will set up: </MutedText>
        <WarningText>{option.stack.join(", ")}</WarningText>
      </Inline>

      <Box marginTop={1}>
        <MutedText>
          Press [Enter/Y] to confirm, [ESC/N] to go back
        </MutedText>
      </Box>
    </Card>
  );
}

// ============================================
// Mini Design Badge (for status bar)
// ============================================

export interface DesignBadgeProps {
  designName?: string;
  isActive?: boolean;
}

export function DesignBadge({ designName, isActive = false }: DesignBadgeProps) {
  if (!designName && !isActive) return null;

  return (
    <Inline gap={0}>
      <StatusDot status={isActive ? "info" : "idle"} />
      <MutedText> Design: </MutedText>
      <Text color={isActive ? "cyan" : undefined} dimColor={!isActive}>
        {designName || "Selecting..."}
      </Text>
    </Inline>
  );
}

// ============================================
// Inline Design Prompt (for chat)
// ============================================

export interface InlineDesignPromptProps {
  message: string;
  compact?: boolean;
}

export function InlineDesignPrompt({ message, compact = false }: InlineDesignPromptProps) {
  const paintbrushIcon = "\u{1F3A8}";

  if (compact) {
    return (
      <Inline gap={0}>
        <Text color="magenta">{paintbrushIcon} </Text>
        <Label>{truncate(message, 60)}...</Label>
      </Inline>
    );
  }

  return (
    <Stack marginY={1}>
      <Inline gap={0}>
        <Label color="magenta">
          {paintbrushIcon} Design Agent
        </Label>
      </Inline>
      <Box paddingLeft={2}>
        <Label>{message}</Label>
      </Box>
    </Stack>
  );
}

// ============================================
// Exports
// ============================================

export default {
  DesignSelector,
  DesignSuggestionPanel,
  DesignConfirmation,
  DesignBadge,
  InlineDesignPrompt,
};
