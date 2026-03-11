/**
 * 8gent Code - Animated Progress Bar
 *
 * Token savings visualization with animations
 */

import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";

interface AnimatedProgressBarProps {
  value: number; // 0-100
  width?: number;
  showPercentage?: boolean;
  color?: string;
  backgroundColor?: string;
  animate?: boolean;
  label?: string;
}

// Gradient colors for the progress bar
const PROGRESS_GRADIENT = [
  "red",
  "yellow",
  "green",
  "cyan",
] as const;

function getGradientColor(percentage: number): string {
  if (percentage < 25) return "red";
  if (percentage < 50) return "yellow";
  if (percentage < 75) return "green";
  return "cyan";
}

export function AnimatedProgressBar({
  value,
  width = 30,
  showPercentage = true,
  color,
  backgroundColor = "gray",
  animate = true,
  label,
}: AnimatedProgressBarProps) {
  const [displayValue, setDisplayValue] = useState(0);
  const [shimmerIndex, setShimmerIndex] = useState(0);

  // Smooth animation to target value
  useEffect(() => {
    if (!animate) {
      setDisplayValue(value);
      return;
    }

    const step = (value - displayValue) / 10;
    if (Math.abs(value - displayValue) < 0.5) {
      setDisplayValue(value);
      return;
    }

    const timeout = setTimeout(() => {
      setDisplayValue((prev) => prev + step);
    }, 30);

    return () => clearTimeout(timeout);
  }, [value, displayValue, animate]);

  // Shimmer effect
  useEffect(() => {
    if (!animate) return;

    const interval = setInterval(() => {
      setShimmerIndex((prev) => (prev + 1) % (width + 5));
    }, 80);

    return () => clearInterval(interval);
  }, [animate, width]);

  const filledWidth = Math.round((displayValue / 100) * width);
  const emptyWidth = width - filledWidth;
  const barColor = color || getGradientColor(displayValue);

  // Build the bar with shimmer effect
  const buildBar = () => {
    const filled = [];
    const empty = [];

    for (let i = 0; i < filledWidth; i++) {
      const isShimmer = i === shimmerIndex || i === shimmerIndex - 1;
      filled.push(
        <Text key={`f${i}`} color={isShimmer ? "white" : barColor}>
          █
        </Text>
      );
    }

    for (let i = 0; i < emptyWidth; i++) {
      empty.push(
        <Text key={`e${i}`} color={backgroundColor} dimColor>
          ░
        </Text>
      );
    }

    return [...filled, ...empty];
  };

  return (
    <Box flexDirection="column">
      {label && (
        <Text color="gray" dimColor>
          {label}
        </Text>
      )}
      <Box>
        <Text color="gray">[</Text>
        {buildBar()}
        <Text color="gray">]</Text>
        {showPercentage && (
          <Text color={barColor}> {Math.round(displayValue)}%</Text>
        )}
      </Box>
    </Box>
  );
}

// Token savings bar with counter animation
interface TokenSavingsBarProps {
  tokensSaved: number;
  maxTokens?: number;
  width?: number;
}

export function TokenSavingsBar({
  tokensSaved,
  maxTokens = 50000,
  width = 25,
}: TokenSavingsBarProps) {
  const [displayTokens, setDisplayTokens] = useState(0);

  // Animate the counter
  useEffect(() => {
    if (displayTokens >= tokensSaved) {
      setDisplayTokens(tokensSaved);
      return;
    }

    const step = Math.max(1, Math.ceil((tokensSaved - displayTokens) / 20));
    const timeout = setTimeout(() => {
      setDisplayTokens((prev) => Math.min(prev + step, tokensSaved));
    }, 20);

    return () => clearTimeout(timeout);
  }, [tokensSaved, displayTokens]);

  const percentage = Math.min((displayTokens / maxTokens) * 100, 100);
  const formattedTokens = displayTokens.toLocaleString();

  return (
    <Box flexDirection="row" gap={1}>
      <Text color="gray">Tokens saved:</Text>
      <Text color="green" bold>
        {formattedTokens}
      </Text>
      <AnimatedProgressBar
        value={percentage}
        width={width}
        showPercentage={false}
        color="green"
      />
    </Box>
  );
}

// Mini sparkline for token history
interface SparklineProps {
  values: number[];
  width?: number;
  color?: string;
}

const SPARK_CHARS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

export function Sparkline({ values, width = 20, color = "cyan" }: SparklineProps) {
  if (values.length === 0) return null;

  const displayValues = values.slice(-width);
  const max = Math.max(...displayValues);
  const min = Math.min(...displayValues);
  const range = max - min || 1;

  return (
    <Box>
      {displayValues.map((value, index) => {
        const normalized = (value - min) / range;
        const charIndex = Math.floor(normalized * (SPARK_CHARS.length - 1));
        return (
          <Text key={index} color={color}>
            {SPARK_CHARS[charIndex]}
          </Text>
        );
      })}
    </Box>
  );
}

// Loading bar with wave animation
interface WaveProgressProps {
  width?: number;
  speed?: number;
}

export function WaveProgress({ width = 30, speed = 100 }: WaveProgressProps) {
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setOffset((prev) => (prev + 1) % width);
    }, speed);

    return () => clearInterval(interval);
  }, [width, speed]);

  const wave = [];
  for (let i = 0; i < width; i++) {
    const distance = Math.abs(i - offset);
    const intensity = Math.max(0, 3 - distance);
    const chars = ["░", "▒", "▓", "█"];
    wave.push(
      <Text key={i} color="cyan">
        {chars[intensity]}
      </Text>
    );
  }

  return (
    <Box>
      <Text color="gray">[</Text>
      {wave}
      <Text color="gray">]</Text>
    </Box>
  );
}
