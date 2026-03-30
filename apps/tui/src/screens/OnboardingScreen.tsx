/**
 * OnboardingScreen - The first impression. Make it count.
 *
 * Design principles (8DO Moira):
 * - Each step is visually distinct with colour and spacing
 * - Progress indicator shows where you are
 * - Questions use cyan, user answers use yellow
 * - Confirmations use green
 * - Voice speaks each question aloud during onboarding
 */

import React, { useState, useEffect } from "react";
import { Box, Text, useStdout } from "ink";

interface OnboardingStep {
  question: string;
  answer?: string;
  status: "pending" | "active" | "done";
}

interface OnboardingScreenProps {
  steps: OnboardingStep[];
  currentQuestion: string;
  stepIndex: number;
  totalSteps: number;
  userName?: string;
  agentName?: string;
}

export function OnboardingScreen({
  steps,
  currentQuestion,
  stepIndex,
  totalSteps,
  userName,
  agentName,
}: OnboardingScreenProps) {
  const { stdout } = useStdout();
  const termWidth = stdout?.columns ?? 80;
  const maxWidth = Math.min(termWidth - 4, 80);

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      {/* Header */}
      <Box marginBottom={1}>
        <Text color="cyan" bold>
          {"  "}8gent Code
        </Text>
        <Text dimColor> | </Text>
        <Text color="yellow" bold>Onboarding</Text>
      </Box>

      {/* Progress bar */}
      <Box marginBottom={1}>
        <Text dimColor>{"  "}Step {stepIndex + 1} of {totalSteps}  </Text>
        {Array.from({ length: totalSteps }).map((_, i) => (
          <Text key={i} color={i < stepIndex ? "green" : i === stepIndex ? "cyan" : undefined} dimColor={i > stepIndex}>
            {i < stepIndex ? " * " : i === stepIndex ? " > " : " - "}
          </Text>
        ))}
      </Box>

      {/* Divider */}
      <Box marginBottom={1}>
        <Text color="cyan">{"  "}{"~".repeat(Math.min(50, maxWidth - 4))}</Text>
      </Box>

      {/* Completed steps - compact */}
      {steps.filter(s => s.status === "done").map((step, i) => (
        <Box key={i} marginBottom={0} paddingLeft={2}>
          <Text color="green" bold>{"* "}</Text>
          <Text dimColor>{step.question.split("\n")[0].slice(0, 50)}</Text>
          {step.answer && (
            <Text color="yellow" bold>{" -> "}{step.answer.slice(0, 30)}</Text>
          )}
        </Box>
      ))}

      {/* Spacer between history and active question */}
      {steps.some(s => s.status === "done") && (
        <Box marginY={1}>
          <Text dimColor>{"  "}{"~".repeat(Math.min(30, maxWidth - 4))}</Text>
        </Box>
      )}

      {/* Active question - prominent */}
      <Box
        flexDirection="column"
        paddingX={2}
        paddingY={1}
        marginBottom={1}
        borderStyle="round"
        borderColor="cyan"
        width={maxWidth}
      >
        {currentQuestion.split("\n").map((line, i) => {
          // Number options get yellow
          if (/^\d+\./.test(line.trim())) {
            return <Text key={i} color="yellow">{line}</Text>;
          }
          // Headers/labels get bold
          if (line.includes(":") && line.indexOf(":") < 20) {
            const [label, ...rest] = line.split(":");
            return (
              <Text key={i}>
                <Text bold>{label}:</Text>
                <Text>{rest.join(":")}</Text>
              </Text>
            );
          }
          // Default text
          return <Text key={i}>{line}</Text>;
        })}
      </Box>

      {/* Input hint */}
      <Box paddingLeft={2}>
        <Text dimColor>Type your answer and press Enter</Text>
      </Box>
    </Box>
  );
}
