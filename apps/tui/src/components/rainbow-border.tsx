/**
 * 8gent Code - Rainbow Border Component
 *
 * Animated border with cycling colors
 */

import React, { useState, useEffect, type ReactNode } from "react";
import { Box, Text } from "ink";
import { AppText, MutedText, Stack } from './primitives/index.js';

// Rainbow color palette
const RAINBOW_COLORS = [
  "#FF0000", // Red
  "#FF7F00", // Orange
  "#FFFF00", // Yellow
  "#00FF00", // Green
  "#0000FF", // Blue
  "#4B0082", // Indigo
  "#9400D3", // Violet
];

const NEON_COLORS = [
  "#FF1493", // Deep Pink
  "#00FFFF", // Cyan
  "#FF00FF", // Magenta
  "#00FF00", // Lime
  "#FF6600", // Orange
  "#00BFFF", // Sky Blue
];

interface RainbowBorderProps {
  children: ReactNode;
  animate?: boolean;
  speed?: number;
  colorPalette?: "rainbow" | "neon" | "mono";
  borderStyle?: "single" | "double" | "round" | "bold" | "classic";
  padding?: number;
}

export function RainbowBorder({
  children,
  animate = true,
  speed = 150,
  colorPalette = "neon",
  borderStyle = "round",
  padding = 1,
}: RainbowBorderProps) {
  const [colorIndex, setColorIndex] = useState(0);

  const colors = colorPalette === "rainbow"
    ? RAINBOW_COLORS
    : colorPalette === "neon"
    ? NEON_COLORS
    : ["cyan"];

  useEffect(() => {
    if (!animate || colors.length <= 1) return;

    const interval = setInterval(() => {
      setColorIndex((prev) => (prev + 1) % colors.length);
    }, speed);

    return () => clearInterval(interval);
  }, [animate, colors.length, speed]);

  return (
    <Box
      borderStyle={borderStyle}
      borderColor={colors[colorIndex]}
      paddingX={padding}
    >
      {children}
    </Box>
  );
}

// Gradient border that smoothly transitions
interface GradientBorderProps {
  children: ReactNode;
  animate?: boolean;
}

export function GradientBorder({
  children,
  animate = true,
}: GradientBorderProps) {
  const [hue, setHue] = useState(0);

  useEffect(() => {
    if (!animate) return;

    const interval = setInterval(() => {
      setHue((prev) => (prev + 5) % 360);
    }, 50);

    return () => clearInterval(interval);
  }, [animate]);

  // Convert HSL to hex
  const hslToHex = (h: number): string => {
    const s = 100;
    const l = 50;
    const a = (s * Math.min(l, 100 - l)) / 100;
    const f = (n: number) => {
      const k = (n + h / 30) % 12;
      const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
      return Math.round((255 * color) / 100)
        .toString(16)
        .padStart(2, "0");
    };
    return `#${f(0)}${f(8)}${f(4)}`;
  };

  return (
    <Box borderStyle="round" borderColor={hslToHex(hue)} paddingX={1}>
      {children}
    </Box>
  );
}

// Pulsing border
interface PulsingBorderProps {
  children: ReactNode;
  color?: string;
  speed?: number;
}

export function PulsingBorder({
  children,
  color = "cyan",
  speed = 500,
}: PulsingBorderProps) {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const interval = setInterval(() => {
      setVisible((prev) => !prev);
    }, speed);

    return () => clearInterval(interval);
  }, [speed]);

  return (
    <Box
      borderStyle="round"
      borderColor={visible ? color : "blue"}
      paddingX={1}
    >
      {children}
    </Box>
  );
}

// Corner decorations with animation
interface DecoratedBoxProps {
  children: ReactNode;
  animate?: boolean;
  width?: number;
}

export function DecoratedBox({
  children,
  animate = true,
  width,
}: DecoratedBoxProps) {
  const [cornerIndex, setCornerIndex] = useState(0);
  const corners = ["◢", "◣", "◤", "◥"];

  useEffect(() => {
    if (!animate) return;

    const interval = setInterval(() => {
      setCornerIndex((prev) => (prev + 1) % 4);
    }, 200);

    return () => clearInterval(interval);
  }, [animate]);

  const getCornerColor = (index: number): string => {
    const distance = (index - cornerIndex + 4) % 4;
    return distance === 0 ? "cyan" : distance === 1 ? "blue" : "gray";
  };

  return (
    <Stack width={width}>
      <Box justifyContent="space-between">
        <AppText color={getCornerColor(0)}>╭</AppText>
        <MutedText>{"─".repeat((width || 40) - 2)}</MutedText>
        <AppText color={getCornerColor(1)}>╮</AppText>
      </Box>
      <Box paddingX={1}>{children}</Box>
      <Box justifyContent="space-between">
        <AppText color={getCornerColor(3)}>╰</AppText>
        <MutedText>{"─".repeat((width || 40) - 2)}</MutedText>
        <AppText color={getCornerColor(2)}>╯</AppText>
      </Box>
    </Stack>
  );
}

// Animated line separator
interface AnimatedSeparatorProps {
  width?: number;
  speed?: number;
  char?: string;
}

export function AnimatedSeparator({
  width = 50,
  speed = 80,
  char = "─",
}: AnimatedSeparatorProps) {
  const [glowIndex, setGlowIndex] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setGlowIndex((prev) => (prev + 1) % (width + 10));
    }, speed);

    return () => clearInterval(interval);
  }, [width, speed]);

  const line = [];
  for (let i = 0; i < width; i++) {
    const distance = Math.abs(i - glowIndex);
    const color = distance === 0
      ? "white"
      : distance <= 2
      ? "cyan"
      : distance <= 4
      ? "blue"
      : "gray";

    line.push(
      <Text key={i} color={color}>
        {char}
      </Text>
    );
  }

  return <Box>{line}</Box>;
}
