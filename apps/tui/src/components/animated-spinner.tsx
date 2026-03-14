/**
 * 8gent Code - Animated Spinner Component
 *
 * Enhanced spinner with multiple animation styles and status text
 */

import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import { MutedText, Label, StatusDot, Inline } from './primitives/index.js';

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
    <MutedText>
      {".".repeat(dots)}
      {" ".repeat(3 - dots)}
    </MutedText>
  );
}

export function AnimatedSpinner({
  type = "dots",
  color = "cyan",
  label = "Processing",
  showDots = true,
}: AnimatedSpinnerProps) {
  return (
    <Inline>
      <Text color={color}><Spinner type={type} /></Text>
      <MutedText> {label}</MutedText>
      {showDots && <ThinkingDots />}
    </Inline>
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
    idle: { symbol: "●", color: "gray", dotStatus: "idle" as const },
    thinking: { symbol: pulse ? "◉" : "○", color: "cyan", dotStatus: "info" as const },
    executing: { symbol: pulse ? "▶" : "▷", color: "yellow", dotStatus: "warning" as const },
    success: { symbol: "✓", color: "green", dotStatus: "success" as const },
    error: { symbol: "✗", color: "red", dotStatus: "error" as const },
  };

  const config = statusConfig[status];

  return (
    <Inline>
      <StatusDot status={config.dotStatus} />
      {label && <MutedText> {label}</MutedText>}
    </Inline>
  );
}

// Multi-step progress indicator
interface StepIndicatorProps {
  steps: string[];
  currentStep: number;
}

export function StepIndicator({ steps, currentStep }: StepIndicatorProps) {
  return (
    <Inline gap={1}>
      {steps.map((step, index) => {
        const isComplete = index < currentStep;
        const isCurrent = index === currentStep;
        const isPending = index > currentStep;

        return (
          <Box key={step}>
            {isComplete && <StatusDot status="success" />}
            {isCurrent && <Text color="cyan"><Spinner type="dots" /></Text>}
            {isPending && <MutedText>○</MutedText>}
            {isCurrent ? (
              <Label> {step}</Label>
            ) : (
              <MutedText> {step}</MutedText>
            )}
            {index < steps.length - 1 && <MutedText> → </MutedText>}
          </Box>
        );
      })}
    </Inline>
  );
}
