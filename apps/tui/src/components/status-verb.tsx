/**
 * 8gent Code - Animated Status Verb Component
 *
 * Displays cycling status verbs that embody the infinite
 * gentleman's personality during processing.
 *
 * Usage:
 *   <AnimatedStatusVerb type="thinking" />
 *   <AnimatedStatusVerb type="executing" showIcon />
 *   <StatusLine type="thinking" elapsed="2m 34s" tokens="1.2k" />
 */

import React, { useState, useEffect, useCallback } from "react";
import { Box, Text } from "ink";

// Import from personality package (relative path for monorepo)
// In production, this would be: import { ... } from "@8gent/personality";

// ============================================
// Status Verb Data (inline for component independence)
// ============================================

const THINKING_VERBS = [
  // Gentleman/Refined
  "Contemplating...",
  "Deliberating...",
  "Musing...",
  "Pondering elegantly...",
  "Ruminating...",
  "Considering the possibilities...",

  // Infinity/8 themed (core brand)
  "Looping infinitely...",
  "Recursing gracefully...",
  "Iterating endlessly...",
  "Spiraling inward...",
  "Transcending limits...",
  "Calculating to infinity...",

  // Coder wit
  "Adjusting monocle...",
  "Polishing algorithms...",
  "Brewing logic...",
  "Refactoring reality...",
  "Compiling thoughts...",
  "Debugging the universe...",
  "Optimizing existence...",

  // Agent swagger
  "Orchestrating...",
  "Deploying brilliance...",
  "Architecting solutions...",
  "Engineering elegance...",
  "Crafting perfection...",
  "Conducting the symphony...",
];

const EXECUTING_VERBS = [
  "Executing with precision...",
  "Making it happen...",
  "Wielding tools...",
  "Operating gracefully...",
  "Performing magic...",
  "Manifesting code...",
  "Applying changes...",
  "Transforming reality...",
  "Implementing elegantly...",
  "Enacting the plan...",
  "Unleashing capability...",
  "Delivering results...",
];

const PLANNING_VERBS = [
  "Scheming brilliantly...",
  "Strategizing...",
  "Plotting the course...",
  "Mapping infinity...",
  "Charting the path...",
  "Devising approach...",
  "Formulating strategy...",
  "Designing the blueprint...",
  "Architecting the plan...",
  "Calculating trajectories...",
];

// ============================================
// Types
// ============================================

export type StatusVerbType = "thinking" | "executing" | "planning";

export interface AnimatedStatusVerbProps {
  /** Type of verbs to cycle through */
  type: StatusVerbType;
  /** Show star icon prefix */
  showIcon?: boolean;
  /** Icon character to use (default: star) */
  icon?: string;
  /** Custom color (default: yellow) */
  color?: string;
  /** Interval between verb changes in ms (default: 2000-3000) */
  intervalMs?: number;
  /** Whether animation is active */
  active?: boolean;
}

export interface StatusLineProps {
  /** Type of verbs to cycle through */
  type: StatusVerbType;
  /** Elapsed time string */
  elapsed?: string;
  /** Token count string */
  tokens?: string;
  /** Show thinking/executing label */
  showLabel?: boolean;
  /** Whether animation is active */
  active?: boolean;
}

// ============================================
// Utility Functions
// ============================================

function getVerbsForType(type: StatusVerbType): string[] {
  switch (type) {
    case "thinking":
      return THINKING_VERBS;
    case "executing":
      return EXECUTING_VERBS;
    case "planning":
      return PLANNING_VERBS;
    default:
      return THINKING_VERBS;
  }
}

function getRandomVerb(type: StatusVerbType): string {
  const verbs = getVerbsForType(type);
  return verbs[Math.floor(Math.random() * verbs.length)];
}

function getNextVerb(type: StatusVerbType, current: string): string {
  const verbs = getVerbsForType(type);
  let next = current;
  let attempts = 0;

  while (next === current && attempts < 10) {
    next = verbs[Math.floor(Math.random() * verbs.length)];
    attempts++;
  }

  return next;
}

// ============================================
// AnimatedStatusVerb Component
// ============================================

export function AnimatedStatusVerb({
  type,
  showIcon = true,
  icon = "\u2726", // Star character
  color = "yellow",
  intervalMs = 2000,
  active = true,
}: AnimatedStatusVerbProps) {
  const [verb, setVerb] = useState(getRandomVerb(type));

  useEffect(() => {
    if (!active) return;

    // Change verb at random intervals (intervalMs to intervalMs + 1000)
    const scheduleNext = () => {
      const delay = intervalMs + Math.random() * 1000;
      return setTimeout(() => {
        setVerb((prev) => getNextVerb(type, prev));
        timeoutId = scheduleNext();
      }, delay);
    };

    let timeoutId = scheduleNext();

    return () => clearTimeout(timeoutId);
  }, [type, intervalMs, active]);

  // Reset verb when type changes
  useEffect(() => {
    setVerb(getRandomVerb(type));
  }, [type]);

  if (!active) {
    return null;
  }

  return (
    <Text color={color as any}>
      {showIcon && <Text>{icon} </Text>}
      {verb}
    </Text>
  );
}

// ============================================
// StatusLine Component (Full Status Display)
// ============================================

export function StatusLine({
  type,
  elapsed,
  tokens,
  showLabel = true,
  active = true,
}: StatusLineProps) {
  const [verb, setVerb] = useState(getRandomVerb(type));

  useEffect(() => {
    if (!active) return;

    const scheduleNext = () => {
      const delay = 2000 + Math.random() * 1000;
      return setTimeout(() => {
        setVerb((prev) => getNextVerb(type, prev));
        timeoutId = scheduleNext();
      }, delay);
    };

    let timeoutId = scheduleNext();

    return () => clearTimeout(timeoutId);
  }, [type, active]);

  useEffect(() => {
    setVerb(getRandomVerb(type));
  }, [type]);

  if (!active) {
    return null;
  }

  // Format: "star Deliberating... (2m 34s . 1.2k tokens . thinking)"
  return (
    <Box>
      <Text color="yellow">
        <Text>{"\u2726"} </Text>
        {verb}
      </Text>
      {(elapsed || tokens || showLabel) && (
        <Text color="gray" dimColor>
          {" ("}
          {elapsed && <Text>{elapsed}</Text>}
          {elapsed && (tokens || showLabel) && <Text> {"\u00B7"} </Text>}
          {tokens && <Text>{tokens} tokens</Text>}
          {tokens && showLabel && <Text> {"\u00B7"} </Text>}
          {showLabel && <Text>{type}</Text>}
          {")"}
        </Text>
      )}
    </Box>
  );
}

// ============================================
// UseStatusVerb Hook
// ============================================

export function useStatusVerb(type: StatusVerbType, intervalMs: number = 2000) {
  const [verb, setVerb] = useState(getRandomVerb(type));
  const [isActive, setIsActive] = useState(false);

  const start = useCallback(() => {
    setIsActive(true);
    setVerb(getRandomVerb(type));
  }, [type]);

  const stop = useCallback(() => {
    setIsActive(false);
  }, []);

  useEffect(() => {
    if (!isActive) return;

    const scheduleNext = () => {
      const delay = intervalMs + Math.random() * 1000;
      return setTimeout(() => {
        setVerb((prev) => getNextVerb(type, prev));
        timeoutId = scheduleNext();
      }, delay);
    };

    let timeoutId = scheduleNext();

    return () => clearTimeout(timeoutId);
  }, [type, intervalMs, isActive]);

  return {
    verb,
    isActive,
    start,
    stop,
  };
}

// ============================================
// Compact Inline Status
// ============================================

export function InlineStatus({
  type,
  active = true,
}: {
  type: StatusVerbType;
  active?: boolean;
}) {
  const [verb, setVerb] = useState(getRandomVerb(type));

  useEffect(() => {
    if (!active) return;

    const interval = setInterval(() => {
      setVerb((prev) => getNextVerb(type, prev));
    }, 2500);

    return () => clearInterval(interval);
  }, [type, active]);

  if (!active) {
    return <Text color="gray">Idle</Text>;
  }

  return (
    <Text color="yellow" dimColor>
      {verb.replace("...", "")}
    </Text>
  );
}

export default AnimatedStatusVerb;
