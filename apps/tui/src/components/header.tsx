/**
 * 8gent Code - Animated Header Component
 *
 * Features:
 * - Gradient text for "8gent"
 * - Pulsing "8" logo when idle
 * - Rainbow border animation
 */

import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import Gradient from "ink-gradient";
import { PulseLogo, AnimatedWordmark } from "./pulse-logo.js";
import { RainbowBorder, AnimatedSeparator } from "./rainbow-border.js";
import { AppText, MutedText, Inline } from './primitives/index.js';

interface HeaderProps {
  isProcessing?: boolean;
  showAnimations?: boolean;
}

export function Header({ isProcessing = false, showAnimations = true }: HeaderProps) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    // Trigger mount animation
    const timeout = setTimeout(() => setMounted(true), 100);
    return () => clearTimeout(timeout);
  }, []);

  if (!mounted && showAnimations) {
    return (
      <Box paddingX={1} marginBottom={1}>
        <MutedText>
          Loading...
        </MutedText>
      </Box>
    );
  }

  return (
    <RainbowBorder
      animate={showAnimations}
      colorPalette="neon"
      speed={200}
      borderStyle="round"
    >
      <Inline gap={1}>
        {/* Animated 8gent logo */}
        <Box>
          <PulseLogo isIdle={!isProcessing} isProcessing={isProcessing} />
          <Gradient name="rainbow">
            <AppText bold>gent</AppText>
          </Gradient>
        </Box>

        {/* Separator */}
        <MutedText> Code</MutedText>

        <MutedText>│</MutedText>

        {/* Tagline with subtle animation */}
        <TaglineText animate={showAnimations} />
      </Inline>
    </RainbowBorder>
  );
}

// Brand identity
const BRAND_TAGLINE = "The Infinite Gentleman";
const BRAND_DESCRIPTION = "Never hit usage caps again";

// Animated tagline component
interface TaglineTextProps {
  animate?: boolean;
}

function TaglineText({ animate = true }: TaglineTextProps) {
  const [glowIndex, setGlowIndex] = useState(-1);
  const text = BRAND_TAGLINE;

  useEffect(() => {
    if (!animate) return;

    const interval = setInterval(() => {
      setGlowIndex((prev) => {
        if (prev >= text.length + 5) return -5;
        return prev + 1;
      });
    }, 80);

    return () => clearInterval(interval);
  }, [animate]);

  if (!animate) {
    return (
      <MutedText>
        {text}
      </MutedText>
    );
  }

  return (
    <Box>
      {text.split("").map((char, index) => {
        const distance = Math.abs(index - glowIndex);
        const color =
          distance === 0
            ? undefined
            : distance <= 1
            ? "cyan"
            : distance <= 3
            ? "blue"
            : undefined;
        const dimColor = distance > 3;
        const bold = distance === 0;

        return (
          <Text key={index} color={color} dimColor={dimColor} bold={bold}>
            {char}
          </Text>
        );
      })}
    </Box>
  );
}

// Compact header for minimal mode
export function CompactHeader({ isProcessing = false }: HeaderProps) {
  return (
    <Box paddingX={1} marginBottom={1} borderStyle="single" borderColor="cyan">
      <AnimatedWordmark isProcessing={isProcessing} />
      <MutedText> Code</MutedText>
    </Box>
  );
}

// Fancy header with ASCII art
export function FancyHeader({ isProcessing = false }: HeaderProps) {
  const [colorIndex, setColorIndex] = useState(0);
  const colors = ["#FF6B6B", "#4ECDC4", "#45B7D1", "#96CEB4", "#FFEAA7", "#DDA0DD"];

  useEffect(() => {
    const interval = setInterval(() => {
      setColorIndex((prev) => (prev + 1) % colors.length);
    }, 300);
    return () => clearInterval(interval);
  }, []);

  return (
    <Box flexDirection="column" marginBottom={1}>
      <RainbowBorder animate colorPalette="neon">
        <Box flexDirection="column" alignItems="center" paddingX={2}>
          <Gradient name="rainbow">
            <Text bold>
              ╔═══════════════════════════════════════╗
            </Text>
          </Gradient>
          <Box>
            <Gradient name="cristal">
              <Text bold>
                {"  "}█████╗  ██████╗ ███████╗███╗   ██╗████████╗{"  "}
              </Text>
            </Gradient>
          </Box>
          <Box>
            <Gradient name="teen">
              <Text bold>
                {" "}██╔══██╗██╔════╝ ██╔════╝████╗  ██║╚══██╔══╝{" "}
              </Text>
            </Gradient>
          </Box>
          <Box>
            <Gradient name="mind">
              <Text bold>
                {" "}╚█████╔╝██║  ███╗█████╗  ██╔██╗ ██║   ██║   {" "}
              </Text>
            </Gradient>
          </Box>
          <Box>
            <Gradient name="morning">
              <Text bold>
                {" "}██╔══██╗██║   ██║██╔══╝  ██║╚██╗██║   ██║   {" "}
              </Text>
            </Gradient>
          </Box>
          <Box>
            <Gradient name="vice">
              <Text bold>
                {" "}╚█████╔╝╚██████╔╝███████╗██║ ╚████║   ██║   {" "}
              </Text>
            </Gradient>
          </Box>
          <Box>
            <Gradient name="passion">
              <Text bold>
                {"  "}╚════╝  ╚═════╝ ╚══════╝╚═╝  ╚═══╝   ╚═╝   {"  "}
              </Text>
            </Gradient>
          </Box>
          <Gradient name="rainbow">
            <Text bold>
              ╚═══════════════════════════════════════╝
            </Text>
          </Gradient>
          <MutedText>
            {BRAND_TAGLINE} | {BRAND_DESCRIPTION}
          </MutedText>
        </Box>
      </RainbowBorder>
    </Box>
  );
}
