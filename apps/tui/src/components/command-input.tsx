/**
 * 8gent Code - Animated Command Input Component
 *
 * Features:
 * - Animated spinner with status text
 * - Pulsing prompt when idle
 * - Step indicator for multi-step operations
 * - Ghost text suggestions (Tab to accept)
 * - Slash command support (/kanban, /predict, /avenues)
 */

import React, { useState, useEffect, useCallback } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import Spinner from "ink-spinner";
import { AnimatedSpinner, StatusIndicator, StepIndicator } from "./animated-spinner.js";
import { WaveProgress } from "./progress-bar.js";
import { Blink } from "./fade-transition.js";
import {
  useGhostSuggestion,
  getSuggestionSourceLabel,
} from "../hooks/use-ghost-suggestion.js";

// ============================================
// Types
// ============================================

interface CommandInputProps {
  onSubmit: (input: string) => void;
  isProcessing: boolean;
  processingStage?: "planning" | "toolshed" | "executing" | "complete";
  showAnimations?: boolean;
  // Ghost suggestion options
  isGitRepo?: boolean;
  currentBranch?: string | null;
  planNextStep?: string | null;
  recentCommands?: string[];
  // Slash command handlers
  onSlashCommand?: (command: string, args: string[]) => void;
}

export type SlashCommand =
  | "help"
  | "kanban"
  | "predict"
  | "avenues"
  | "clear"
  | "quit"
  | "plan"
  | "status"
  | "model"
  | "provider"
  | "voice"
  | "language"
  | "infinite"
  | "onboarding"
  | "preferences"
  | "skip"
  | "animations";

// Processing stages for multi-step indicator
const PROCESSING_STAGES = ["Plan", "Tools", "Execute"];

// ============================================
// Slash Command Definitions
// ============================================

interface SlashCommandDef {
  name: SlashCommand;
  aliases: string[];
  description: string;
  usage?: string;
}

const SLASH_COMMANDS: SlashCommandDef[] = [
  {
    name: "help",
    aliases: ["h", "?"],
    description: "Show available commands",
  },
  {
    name: "kanban",
    aliases: ["k", "board"],
    description: "Toggle kanban board view",
  },
  {
    name: "predict",
    aliases: ["p", "next"],
    description: "Show predicted next steps",
  },
  {
    name: "avenues",
    aliases: ["a", "paths"],
    description: "Show all planned avenues",
  },
  {
    name: "plan",
    aliases: ["pl"],
    description: "Show current execution plan",
  },
  {
    name: "clear",
    aliases: ["cls", "c"],
    description: "Clear the screen",
  },
  {
    name: "status",
    aliases: ["s", "st"],
    description: "Show session status",
  },
  {
    name: "quit",
    aliases: ["q", "exit"],
    description: "Exit 8gent Code",
  },
  {
    name: "model",
    aliases: ["m"],
    description: "Select LLM model (↑↓ to scroll)",
    usage: "/model [name]",
  },
  {
    name: "provider",
    aliases: ["pr"],
    description: "Select LLM provider (↑↓ to scroll)",
    usage: "/provider [name]",
  },
  {
    name: "voice",
    aliases: ["v"],
    description: "Voice TTS settings",
    usage: "/voice [on|off|test]",
  },
  {
    name: "language",
    aliases: ["lang", "l"],
    description: "Set response language",
    usage: "/language [code]",
  },
  {
    name: "infinite",
    aliases: ["inf", "∞"],
    description: "Enable infinite mode (autonomous until done)",
    usage: "/infinite [task]",
  },
  {
    name: "onboarding",
    aliases: ["onboard", "setup", "intro"],
    description: "Start or restart personalization setup",
    usage: "/onboarding",
  },
  {
    name: "preferences",
    aliases: ["prefs", "settings"],
    description: "View or edit your preferences",
    usage: "/preferences [category]",
  },
  {
    name: "skip",
    aliases: ["later"],
    description: "Skip current onboarding question",
    usage: "/skip [all]",
  },
  {
    name: "animations",
    aliases: ["anim", "fx"],
    description: "Preview ASCII animations",
    usage: "/animations [matrix|fire|dna|stars|dots|glitch|confetti|wave|cube|all]",
  },
];

// ============================================
// Main Command Input
// ============================================

export function CommandInput({
  onSubmit,
  isProcessing,
  processingStage = "planning",
  showAnimations = true,
  isGitRepo = false,
  currentBranch = null,
  planNextStep = null,
  recentCommands = [],
  onSlashCommand,
}: CommandInputProps) {
  const [value, setValue] = useState("");
  const [promptPulse, setPromptPulse] = useState(true);
  const [showSlashHelp, setShowSlashHelp] = useState(false);

  // Ghost suggestion hook
  const { suggestion, accept, dismiss, isVisible } = useGhostSuggestion(value, {
    isGitRepo,
    currentBranch,
    planNextStep,
    recentCommands,
  });

  // Pulsing prompt animation when idle
  useEffect(() => {
    if (isProcessing) return;

    const interval = setInterval(() => {
      setPromptPulse((prev) => !prev);
    }, 800);

    return () => clearInterval(interval);
  }, [isProcessing]);

  // Show slash help when typing /
  useEffect(() => {
    setShowSlashHelp(value.startsWith("/") && value.length < 10);
  }, [value]);

  // Handle keyboard input
  useInput(
    (input, key) => {
      // Tab to accept ghost suggestion
      if (key.tab && isVisible && suggestion) {
        const newValue = accept();
        setValue(newValue);
        return;
      }

      // Escape to dismiss suggestion
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

      // Check for slash command
      if (input.startsWith("/")) {
        const parts = input.slice(1).split(/\s+/);
        const cmdName = parts[0].toLowerCase();
        const args = parts.slice(1);

        // Find matching command
        const cmd = SLASH_COMMANDS.find(
          (c) => c.name === cmdName || c.aliases.includes(cmdName)
        );

        if (cmd && onSlashCommand) {
          onSlashCommand(cmd.name, args);
          setValue("");
          return;
        }
      }

      // Regular command
      onSubmit(input);
      setValue("");
    },
    [onSubmit, onSlashCommand]
  );

  // Get current step index
  const getCurrentStep = (): number => {
    switch (processingStage) {
      case "planning":
        return 0;
      case "toolshed":
        return 1;
      case "executing":
        return 2;
      case "complete":
        return 3;
      default:
        return 0;
    }
  };

  if (isProcessing) {
    return (
      <Box flexDirection="column" paddingX={1}>
        {/* Main processing indicator */}
        <Box marginBottom={1}>
          <AnimatedSpinner
            type="dots"
            color="cyan"
            label={getProcessingLabel(processingStage)}
            showDots={true}
          />
        </Box>

        {/* Step indicator */}
        {showAnimations && (
          <Box marginBottom={1}>
            <StepIndicator steps={PROCESSING_STAGES} currentStep={getCurrentStep()} />
          </Box>
        )}

        {/* Wave progress bar */}
        {showAnimations && <WaveProgress width={40} speed={80} />}
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      {/* Main input row */}
      <Box>
        {/* Animated prompt */}
        <PromptIndicator pulse={promptPulse && showAnimations} />
        <Text> </Text>

        {/* Text input with ghost overlay */}
        <Box>
          <TextInput
            value={value}
            onChange={setValue}
            onSubmit={handleSubmit}
            placeholder={isVisible ? "" : "Type a command or ask a question..."}
          />

          {/* Ghost suggestion text */}
          {isVisible && suggestion && (
            <Text color="gray" dimColor>
              {suggestion.text}
            </Text>
          )}
        </Box>
      </Box>

      {/* Ghost suggestion hint */}
      {isVisible && suggestion && (
        <Box paddingLeft={2}>
          <Text color="blue">[Tab]</Text>
          <Text color="gray" dimColor> to accept ({getSuggestionSourceLabel(suggestion.source)})</Text>
        </Box>
      )}

      {/* Slash command help */}
      {showSlashHelp && <SlashCommandHelp filter={value.slice(1)} />}
    </Box>
  );
}

// ============================================
// Sub-Components
// ============================================

// Animated prompt indicator
interface PromptIndicatorProps {
  pulse: boolean;
}

function PromptIndicator({ pulse }: PromptIndicatorProps) {
  const [colorIndex, setColorIndex] = useState(0);
  const colors = ["cyan", "blue", "magenta", "cyan"];

  useEffect(() => {
    const interval = setInterval(() => {
      setColorIndex((prev) => (prev + 1) % colors.length);
    }, 300);

    return () => clearInterval(interval);
  }, []);

  return (
    <Text color={colors[colorIndex] as any} bold>
      {"\u276F"}
    </Text>
  );
}

function getProcessingLabel(stage: string): string {
  switch (stage) {
    case "planning":
      return "Planning approach";
    case "toolshed":
      return "Querying toolshed";
    case "executing":
      return "Executing";
    case "complete":
      return "Finalizing";
    default:
      return "Processing";
  }
}

// Slash command help dropdown
function SlashCommandHelp({ filter }: { filter: string }) {
  const filtered = SLASH_COMMANDS.filter(
    (cmd) =>
      cmd.name.startsWith(filter.toLowerCase()) ||
      cmd.aliases.some((a) => a.startsWith(filter.toLowerCase()))
  );

  if (filtered.length === 0) return null;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="gray"
      paddingX={1}
      marginTop={1}
    >
      <Text color="gray" dimColor>
        Commands:
      </Text>
      {filtered.slice(0, 6).map((cmd) => (
        <Box key={cmd.name}>
          <Text color="cyan">/{cmd.name}</Text>
          <Text color="gray" dimColor>
            {" "}- {cmd.description}
          </Text>
        </Box>
      ))}
    </Box>
  );
}

// ============================================
// Minimal Command Input
// ============================================

export function MinimalCommandInput({
  onSubmit,
  isProcessing,
}: CommandInputProps) {
  const [value, setValue] = useState("");

  const handleSubmit = (input: string) => {
    if (!input.trim()) return;
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
          <Text color="gray"> Working...</Text>
        </Box>
      ) : (
        <Box>
          <Text color="cyan" bold>
            ${" "}
          </Text>
          <TextInput
            value={value}
            onChange={setValue}
            onSubmit={handleSubmit}
            placeholder="Enter command..."
          />
        </Box>
      )}
    </Box>
  );
}

// ============================================
// Multi-line Command Input
// ============================================

interface MultiLineInputProps {
  onSubmit: (input: string) => void;
  isProcessing: boolean;
}

export function MultiLineInput({ onSubmit, isProcessing }: MultiLineInputProps) {
  const [lines, setLines] = useState<string[]>([""]);
  const [currentLine, setCurrentLine] = useState(0);

  // Not fully implemented - placeholder for future
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text color="gray" dimColor>
        Multi-line mode (Ctrl+Enter to submit)
      </Text>
      {lines.map((line, index) => (
        <Box key={index}>
          <Text color="gray">{index === currentLine ? "\u276F" : " "} </Text>
          <Text>{line}</Text>
        </Box>
      ))}
    </Box>
  );
}

// ============================================
// Command Palette Style Input
// ============================================

interface CommandPaletteProps {
  onSubmit: (input: string) => void;
  suggestions?: string[];
}

export function CommandPalette({ onSubmit, suggestions = [] }: CommandPaletteProps) {
  const [value, setValue] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);

  const filteredSuggestions = suggestions.filter((s) =>
    s.toLowerCase().includes(value.toLowerCase())
  );

  useInput((input, key) => {
    if (key.downArrow) {
      setSelectedIndex((prev) =>
        Math.min(prev + 1, filteredSuggestions.length - 1)
      );
    } else if (key.upArrow) {
      setSelectedIndex((prev) => Math.max(prev - 1, 0));
    }
  });

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box
        borderStyle="round"
        borderColor="cyan"
        paddingX={1}
        flexDirection="column"
      >
        <Box>
          <Text color="cyan" bold>
            {"\u276F"}{" "}
          </Text>
          <TextInput
            value={value}
            onChange={(v) => {
              setValue(v);
              setSelectedIndex(0);
            }}
            onSubmit={() => {
              const selected = filteredSuggestions[selectedIndex] || value;
              onSubmit(selected);
              setValue("");
            }}
          />
        </Box>

        {value && filteredSuggestions.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            {filteredSuggestions.slice(0, 5).map((suggestion, index) => (
              <Box key={suggestion}>
                <Text
                  color={index === selectedIndex ? "cyan" : "gray"}
                  bold={index === selectedIndex}
                >
                  {index === selectedIndex ? "\u25B8 " : "  "}
                  {suggestion}
                </Text>
              </Box>
            ))}
          </Box>
        )}
      </Box>
    </Box>
  );
}

// ============================================
// Ghost-Enhanced Command Input
// ============================================

export interface GhostCommandInputProps {
  onSubmit: (input: string) => void;
  isProcessing: boolean;
  isGitRepo?: boolean;
  currentBranch?: string | null;
  planNextStep?: string | null;
  recentCommands?: string[];
  onSlashCommand?: (command: string, args: string[]) => void;
}

export function GhostCommandInput({
  onSubmit,
  isProcessing,
  isGitRepo = false,
  currentBranch = null,
  planNextStep = null,
  recentCommands = [],
  onSlashCommand,
}: GhostCommandInputProps) {
  return (
    <CommandInput
      onSubmit={onSubmit}
      isProcessing={isProcessing}
      isGitRepo={isGitRepo}
      currentBranch={currentBranch}
      planNextStep={planNextStep}
      recentCommands={recentCommands}
      onSlashCommand={onSlashCommand}
    />
  );
}

// ============================================
// Export Slash Commands for External Use
// ============================================

export function getSlashCommands(): SlashCommandDef[] {
  return SLASH_COMMANDS;
}

export function isSlashCommand(input: string): boolean {
  if (!input.startsWith("/")) return false;
  const cmdName = input.slice(1).split(/\s+/)[0].toLowerCase();
  return SLASH_COMMANDS.some(
    (c) => c.name === cmdName || c.aliases.includes(cmdName)
  );
}

export function parseSlashCommand(
  input: string
): { command: SlashCommand; args: string[] } | null {
  if (!input.startsWith("/")) return null;

  const parts = input.slice(1).split(/\s+/);
  const cmdName = parts[0].toLowerCase();
  const args = parts.slice(1);

  const cmd = SLASH_COMMANDS.find(
    (c) => c.name === cmdName || c.aliases.includes(cmdName)
  );

  if (!cmd) return null;

  return { command: cmd.name, args };
}
