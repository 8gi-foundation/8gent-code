/**
 * 8gent Code - Pulse Logo Component
 *
 * Animated "8" logo with breathing/pulse effects
 */

import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";

interface PulseLogoProps {
  isIdle?: boolean;
  isProcessing?: boolean;
}

// Color palette for gradient cycling
const GRADIENT_COLORS = [
  "#00FFFF", // cyan
  "#00BFFF", // deep sky blue
  "#0080FF", // blue
  "#4040FF", // indigo
  "#8000FF", // violet
  "#BF00FF", // magenta
  "#FF00BF", // pink
  "#FF0080", // hot pink
  "#FF0040", // red-pink
  "#FF4000", // orange-red
  "#FF8000", // orange
  "#FFBF00", // gold
  "#FFFF00", // yellow
  "#BFFF00", // lime
  "#00FF40", // green
  "#00FF80", // sea green
  "#00FFBF", // turquoise
];

export function PulseLogo({ isIdle = true, isProcessing = false }: PulseLogoProps) {
  const [colorIndex, setColorIndex] = useState(0);
  const [brightness, setBrightness] = useState(1);
  const [breathingIn, setBreathingIn] = useState(true);

  // Rainbow color cycling when processing
  useEffect(() => {
    if (!isProcessing) return;

    const interval = setInterval(() => {
      setColorIndex((prev) => (prev + 1) % GRADIENT_COLORS.length);
    }, 100);

    return () => clearInterval(interval);
  }, [isProcessing]);

  // Breathing effect when idle
  useEffect(() => {
    if (!isIdle || isProcessing) return;

    const interval = setInterval(() => {
      setBrightness((prev) => {
        if (breathingIn) {
          if (prev >= 1) {
            setBreathingIn(false);
            return prev - 0.1;
          }
          return prev + 0.1;
        } else {
          if (prev <= 0.3) {
            setBreathingIn(true);
            return prev + 0.1;
          }
          return prev - 0.1;
        }
      });
    }, 150);

    return () => clearInterval(interval);
  }, [isIdle, isProcessing, breathingIn]);

  // Get current color
  const currentColor = isProcessing
    ? GRADIENT_COLORS[colorIndex]
    : brightness > 0.7 ? "cyan" : brightness > 0.4 ? "blue" : "gray";

  return (
    <Text bold color={currentColor}>
      8
    </Text>
  );
}

// Large ASCII art "8" logo with animation
interface BigLogoProps {
  animate?: boolean;
  size?: "small" | "medium" | "large";
}

const SMALL_8 = [
  " ██████ ",
  "██    ██",
  " ██████ ",
  "██    ██",
  " ██████ ",
];

const MEDIUM_8 = [
  "  ████████  ",
  " ██      ██ ",
  "  ████████  ",
  " ██      ██ ",
  "  ████████  ",
];

export function BigLogo({ animate = true, size = "small" }: BigLogoProps) {
  const [colorIndex, setColorIndex] = useState(0);
  const logo = size === "small" ? SMALL_8 : MEDIUM_8;

  useEffect(() => {
    if (!animate) return;

    const interval = setInterval(() => {
      setColorIndex((prev) => (prev + 1) % GRADIENT_COLORS.length);
    }, 150);

    return () => clearInterval(interval);
  }, [animate]);

  return (
    <Box flexDirection="column">
      {logo.map((line, index) => (
        <Text
          key={index}
          color={GRADIENT_COLORS[(colorIndex + index * 2) % GRADIENT_COLORS.length]}
          bold
        >
          {line}
        </Text>
      ))}
    </Box>
  );
}

// Spinning ring animation
interface SpinningRingProps {
  speed?: number;
}

const RING_FRAMES = ["◐", "◓", "◑", "◒"];

export function SpinningRing({ speed = 100 }: SpinningRingProps) {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setFrame((prev) => (prev + 1) % RING_FRAMES.length);
    }, speed);

    return () => clearInterval(interval);
  }, [speed]);

  return <Text color="cyan">{RING_FRAMES[frame]}</Text>;
}

// Animated 8gent wordmark
interface AnimatedWordmarkProps {
  isProcessing?: boolean;
}

export function AnimatedWordmark({ isProcessing = false }: AnimatedWordmarkProps) {
  const [glowIndex, setGlowIndex] = useState(0);
  const text = "8gent";

  useEffect(() => {
    const interval = setInterval(() => {
      setGlowIndex((prev) => (prev + 1) % (text.length + 3));
    }, 200);

    return () => clearInterval(interval);
  }, []);

  return (
    <Box>
      {text.split("").map((char, index) => {
        const isGlowing = index === glowIndex || index === glowIndex - 1;
        const color = index === 0
          ? (isProcessing ? GRADIENT_COLORS[glowIndex % GRADIENT_COLORS.length] : "cyan")
          : isGlowing ? "white" : "gray";

        return (
          <Text key={index} bold={index === 0 || isGlowing} color={color}>
            {char}
          </Text>
        );
      })}
    </Box>
  );
}
