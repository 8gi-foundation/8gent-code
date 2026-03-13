/**
 * 8gent Code - Animated Spinner Component
 *
 * Enhanced spinner with multiple animation styles and status text
 */

import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";

type SpinnerStyle = "dots" | "line" | "arc" | "bouncingBar" | "moon" | "runner";

interface AnimatedSpinnerProps {
  type?: SpinnerStyle;
  color?: string;
  label?: string;
  showDots?: boolean;
}

// Animated "thinking" dots that cycle
function ThinkingDots() {
  const [dots, setDots] = useState(1);

  useEffect(() => {
    const interval = setInterval(() => {
      setDots((prev) => (prev % 3) + 1);
    }, 400);
    return () => clearInterval(interval);
  }, []);

  return (
    <Text dimColor>
      {".".repeat(dots)}
      {" ".repeat(3 - dots)}
    </Text>
  );
}

export function AnimatedSpinner({
  type = "dots",
  color = "cyan",
  label = "Processing",
  showDots = true,
}: AnimatedSpinnerProps) {
  return (
    <Box>
      <Text color={color}><Spinner type={type} /></Text>
      <Text dimColor> {label}</Text>
      {showDots && <ThinkingDots />}
    </Box>
  );
}

// Status indicator with pulsing animation
interface StatusIndicatorProps {
  status: "idle" | "thinking" | "executing" | "success" | "error";
  label?: string;
}

export function StatusIndicator({ status, label }: StatusIndicatorProps) {
  const [pulse, setPulse] = useState(true);

  useEffect(() => {
    if (status === "thinking" || status === "executing") {
      const interval = setInterval(() => {
        setPulse((prev) => !prev);
      }, 500);
      return () => clearInterval(interval);
    }
  }, [status]);

  const statusConfig = {
    idle: { symbol: "●", color: "gray" },
    thinking: { symbol: pulse ? "◉" : "○", color: "cyan" },
    executing: { symbol: pulse ? "▶" : "▷", color: "yellow" },
    success: { symbol: "✓", color: "green" },
    error: { symbol: "✗", color: "red" },
  };

  const config = statusConfig[status];

  return (
    <Box>
      <Text color={config.color}>{config.symbol}</Text>
      {label && <Text dimColor> {label}</Text>}
    </Box>
  );
}

// Multi-step progress indicator
interface StepIndicatorProps {
  steps: string[];
  currentStep: number;
}

export function StepIndicator({ steps, currentStep }: StepIndicatorProps) {
  return (
    <Box flexDirection="row" gap={1}>
      {steps.map((step, index) => {
        const isComplete = index < currentStep;
        const isCurrent = index === currentStep;
        const isPending = index > currentStep;

        return (
          <Box key={step}>
            {isComplete && <Text color="green">✓</Text>}
            {isCurrent && <Text color="cyan"><Spinner type="dots" /></Text>}
            {isPending && <Text dimColor>○</Text>}
            <Text bold={isCurrent} dimColor={!isCurrent}> {step}</Text>
            {index < steps.length - 1 && <Text dimColor> → </Text>}
          </Box>
        );
      })}
    </Box>
  );
}
