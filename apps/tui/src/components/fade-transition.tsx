/**
 * 8gent Code - Fade Transition Component
 *
 * Smooth fade in/out effects for messages and content
 */

import React, { useState, useEffect, type ReactNode } from "react";
import { Box, Text } from "ink";

interface FadeInProps {
  children: ReactNode;
  duration?: number; // Total duration in ms
  delay?: number; // Delay before starting
  onComplete?: () => void;
}

// Opacity levels using different characters/dimming
const FADE_LEVELS = [
  { dimColor: true, color: "gray" },
  { dimColor: true, color: "white" },
  { dimColor: false, color: "gray" },
  { dimColor: false, color: "white" },
];

export function FadeIn({
  children,
  duration = 300,
  delay = 0,
  onComplete,
}: FadeInProps) {
  const [started, setStarted] = useState(false);

  // Handle delay
  useEffect(() => {
    const timeout = setTimeout(() => {
      setStarted(true);
    }, delay);
    return () => clearTimeout(timeout);
  }, [delay]);

  // Trigger onComplete after duration
  useEffect(() => {
    if (!started) return;

    const timeout = setTimeout(() => {
      onComplete?.();
    }, duration);
    return () => clearTimeout(timeout);
  }, [started, duration, onComplete]);

  if (!started) return null;

  // Use Box wrapper to support any children type (Box, Text, etc.)
  return <Box>{children}</Box>;
}

// Fade out component
interface FadeOutProps {
  children: ReactNode;
  duration?: number;
  trigger?: boolean;
  onComplete?: () => void;
}

export function FadeOut({
  children,
  duration = 300,
  trigger = false,
  onComplete,
}: FadeOutProps) {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    if (!trigger) return;

    const timeout = setTimeout(() => {
      setVisible(false);
      onComplete?.();
    }, duration);
    return () => clearTimeout(timeout);
  }, [trigger, duration, onComplete]);

  if (!visible) return null;

  // Use Box wrapper to support any children type (Box, Text, etc.)
  return <Box>{children}</Box>;
}

// Slide in from left effect
interface SlideInProps {
  children: string;
  duration?: number;
  direction?: "left" | "right";
}

export function SlideIn({
  children,
  duration = 200,
  direction = "left",
}: SlideInProps) {
  const [visibleChars, setVisibleChars] = useState(0);
  const text = typeof children === "string" ? children : String(children);

  useEffect(() => {
    if (visibleChars >= text.length) return;

    const charDuration = duration / text.length;
    const timeout = setTimeout(() => {
      setVisibleChars((prev) => prev + 1);
    }, charDuration);

    return () => clearTimeout(timeout);
  }, [visibleChars, text.length, duration]);

  if (direction === "left") {
    return <Text>{text.slice(0, visibleChars)}</Text>;
  } else {
    const start = text.length - visibleChars;
    return (
      <Text>
        {" ".repeat(start)}
        {text.slice(start)}
      </Text>
    );
  }
}

// Pop in effect (scale simulation)
interface PopInProps {
  children: ReactNode;
  delay?: number;
}

export function PopIn({ children, delay = 0 }: PopInProps) {
  const [started, setStarted] = useState(false);

  useEffect(() => {
    const timeout = setTimeout(() => {
      setStarted(true);
    }, delay);
    return () => clearTimeout(timeout);
  }, [delay]);

  if (!started) return null;

  // Use Box wrapper to support any children type (Box, Text, etc.)
  return <Box>{children}</Box>;
}

// Blink effect
interface BlinkProps {
  children: ReactNode;
  speed?: number;
  color?: string;
  times?: number; // Number of blinks, -1 for infinite
}

export function Blink({
  children,
  speed = 500,
  color = "cyan",
  times = -1,
}: BlinkProps) {
  const [visible, setVisible] = useState(true);
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (times !== -1 && count >= times * 2) return;

    const interval = setInterval(() => {
      setVisible((prev) => !prev);
      setCount((prev) => prev + 1);
    }, speed);

    return () => clearInterval(interval);
  }, [speed, times, count]);

  // Use Box wrapper to support any children type (Box, Text, etc.)
  // Visibility is controlled by showing/hiding content
  if (!visible) return null;

  return <Box>{children}</Box>;
}

// Cascading fade for list items
interface CascadeFadeProps {
  items: ReactNode[];
  delay?: number; // Delay between each item
  itemDuration?: number;
}

export function CascadeFade({
  items,
  delay = 100,
  itemDuration = 200,
}: CascadeFadeProps) {
  return (
    <Box flexDirection="column">
      {items.map((item, index) => (
        <FadeIn key={index} delay={index * delay} duration={itemDuration}>
          {item}
        </FadeIn>
      ))}
    </Box>
  );
}

// Glowing text effect
interface GlowTextProps {
  children: string;
  color?: string;
  speed?: number;
}

export function GlowText({
  children,
  color = "cyan",
  speed = 200,
}: GlowTextProps) {
  const [glowIndex, setGlowIndex] = useState(0);
  const text = children;

  useEffect(() => {
    const interval = setInterval(() => {
      setGlowIndex((prev) => (prev + 1) % (text.length + 5));
    }, speed);

    return () => clearInterval(interval);
  }, [text.length, speed]);

  return (
    <Box>
      {text.split("").map((char, index) => {
        const distance = Math.abs(index - glowIndex);
        const isGlowing = distance <= 1;
        const isFading = distance <= 3;

        return (
          <Text
            key={index}
            color={isGlowing ? "white" : isFading ? color : "gray"}
            bold={isGlowing}
          >
            {char}
          </Text>
        );
      })}
    </Box>
  );
}
