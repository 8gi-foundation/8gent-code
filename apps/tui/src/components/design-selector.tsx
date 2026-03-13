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
    <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1}>
      {/* Header */}
      <Box marginBottom={1}>
        <Text color="magenta" bold>
          {pulseChar} Design Direction
        </Text>
      </Box>

      {/* Intro */}
      <Box marginBottom={1}>
        <Text bold>{intro}</Text>
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
        <Box marginTop={1} flexDirection="column">
          <Text dimColor>
            Press [1-{options.length}] to select, or use \u2191\u2193 and Enter
          </Text>
          {onCancel && (
            <Text dimColor>
              Press [ESC] to skip design selection
            </Text>
          )}
        </Box>
      )}
    </Box>
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
      <Box justifyContent="space-between">
        <Box>
          <Text color="yellow" bold>
            [{index}]
          </Text>
          <Text color={isSelected ? "cyan" : undefined} bold>
            {" "}
            {option.name}
          </Text>
        </Box>
        <Text dimColor>
          {Math.round(option.score)}% match
        </Text>
      </Box>

      {/* Description */}
      <Text bold>{option.description}</Text>

      {/* Reasoning */}
      <Box marginTop={0}>
        <Text color="green" italic>
          \u2192 {option.reasoning}
        </Text>
      </Box>

      {/* Stack */}
      <Box marginTop={0}>
        <Text dimColor>Stack: </Text>
        <Text color="cyan">{option.stack.join(" \u2022 ")}</Text>
      </Box>

      {/* ASCII Preview */}
      {option.preview && (
        <Box marginTop={1}>
          <Text dimColor>{option.preview.content}</Text>
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
    <Box flexDirection="column" borderStyle="round" borderColor="green" paddingX={1}>
      <Box marginBottom={1}>
        <Text color="green" bold>
          \u2713 Confirm Selection
        </Text>
      </Box>

      <Text bold>
        You selected: <Text color="cyan" bold>{option.name}</Text>
      </Text>

      <Box marginTop={1}>
        <Text dimColor>This will set up: </Text>
        <Text color="yellow">{option.stack.join(", ")}</Text>
      </Box>

      <Box marginTop={1}>
        <Text dimColor>
          Press [Enter/Y] to confirm, [ESC/N] to go back
        </Text>
      </Box>
    </Box>
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
    <Box>
      <Text color="magenta">
        {isActive ? "\u25CF" : "\u25CB"}
      </Text>
      <Text dimColor> Design: </Text>
      <Text color={isActive ? "cyan" : undefined} dimColor={!isActive}>
        {designName || "Selecting..."}
      </Text>
    </Box>
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
      <Box>
        <Text color="magenta">{paintbrushIcon} </Text>
        <Text bold>{message.slice(0, 60)}...</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginY={1}>
      <Box>
        <Text color="magenta" bold>
          {paintbrushIcon} Design Agent
        </Text>
      </Box>
      <Box paddingLeft={2}>
        <Text bold>{message}</Text>
      </Box>
    </Box>
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
