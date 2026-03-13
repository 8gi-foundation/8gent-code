/**
 * 8gent Code - Animation Showcase
 *
 * Interactive preview of all ASCII animations.
 * Triggered via /animations command.
 */

import React, { useState, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import { AppText, MutedText, Label, ShortcutHint, Inline, Stack, Divider } from './primitives/index.js';
import {
  MatrixRain,
  FireEffect,
  DNAHelix,
  Starfield,
  BouncingDots,
  GlitchText,
  Confetti,
  Waveform,
  GradientWave,
} from "./advanced-animations.js";

// ============================================
// Types
// ============================================

export type AnimationType =
  | "matrix"
  | "fire"
  | "dna"
  | "stars"
  | "dots"
  | "glitch"
  | "confetti"
  | "wave"
  | "gradient"
  | "all";

interface AnimationShowcaseProps {
  animation?: AnimationType;
  onClose?: () => void;
}

interface AnimationInfo {
  id: AnimationType;
  name: string;
  description: string;
  component: React.ReactNode;
}

// ============================================
// Animation Registry
// ============================================

const ANIMATIONS: AnimationInfo[] = [
  {
    id: "matrix",
    name: "Matrix Rain",
    description: "Japanese characters falling like The Matrix",
    component: <MatrixRain width={50} height={12} />,
  },
  {
    id: "fire",
    name: "Fire Effect",
    description: "Thermal propagation flames",
    component: <FireEffect width={50} height={8} />,
  },
  {
    id: "dna",
    name: "DNA Helix",
    description: "Rotating double helix with base pairs",
    component: <DNAHelix width={40} height={10} />,
  },
  {
    id: "stars",
    name: "Starfield Warp",
    description: "3D starfield with warp speed",
    component: <Starfield width={50} height={12} warp />,
  },
  {
    id: "dots",
    name: "Bouncing Braille",
    description: "Physics simulation with Braille dots",
    component: <BouncingDots width={40} height={8} count={12} />,
  },
  {
    id: "glitch",
    name: "Glitch Text",
    description: "Cyberpunk text corruption effect",
    component: <GlitchText text="8GENT CODE - THE INFINITE GENTLEMAN" intensity={0.2} />,
  },
  {
    id: "confetti",
    name: "Confetti Burst",
    description: "Celebration particle explosion",
    component: <Confetti width={50} height={12} duration={5000} />,
  },
  {
    id: "wave",
    name: "Audio Waveform",
    description: "Voice mode visualizer",
    component: <Waveform width={40} active />,
  },
  {
    id: "gradient",
    name: "Gradient Wave",
    description: "Rainbow cycling text effect",
    component: <GradientWave text="✦ 8gent Code - The Infinite Gentleman ✦" speed={100} />,
  },
];

// ============================================
// Main Showcase Component
// ============================================

export function AnimationShowcase({ animation = "all", onClose }: AnimationShowcaseProps) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isGallery, setIsGallery] = useState(animation === "all");

  // Find specific animation if not "all"
  const targetAnimation = animation !== "all"
    ? ANIMATIONS.find(a => a.id === animation)
    : null;

  // Handle keyboard navigation
  useInput((input, key) => {
    if (key.escape || input === "q") {
      onClose?.();
      return;
    }

    if (isGallery) {
      if (key.leftArrow || input === "h") {
        setCurrentIndex(i => (i - 1 + ANIMATIONS.length) % ANIMATIONS.length);
      } else if (key.rightArrow || input === "l") {
        setCurrentIndex(i => (i + 1) % ANIMATIONS.length);
      } else if (key.upArrow || input === "k") {
        setCurrentIndex(i => Math.max(0, i - 1));
      } else if (key.downArrow || input === "j") {
        setCurrentIndex(i => Math.min(ANIMATIONS.length - 1, i + 1));
      }
    }
  });

  // Single animation view
  if (targetAnimation) {
    return (
      <Stack borderStyle="round" borderColor="cyan" paddingX={2} paddingY={1}>
        <Box marginBottom={1}>
          <GradientWave text={`✦ ${targetAnimation.name} ✦`} speed={120} />
        </Box>
        <MutedText>{targetAnimation.description}</MutedText>
        <Box marginY={1}>
          {targetAnimation.component}
        </Box>
        <Box marginTop={1}>
          <ShortcutHint keys="[ESC]" description="close" />
        </Box>
      </Stack>
    );
  }

  // Gallery view
  const current = ANIMATIONS[currentIndex];

  return (
    <Stack borderStyle="double" borderColor="magenta" paddingX={2} paddingY={1}>
      {/* Header */}
      <Box marginBottom={1} justifyContent="center">
        <GradientWave text="✦ 8GENT ANIMATION GALLERY ✦" speed={80} />
      </Box>

      {/* Navigation dots */}
      <Inline justifyContent="center" marginBottom={1} gap={0}>
        {ANIMATIONS.map((_, i) => (
          <AppText key={i} color={i === currentIndex ? "cyan" : undefined} dimColor={i !== currentIndex}>
            {i === currentIndex ? "●" : "○"}{" "}
          </AppText>
        ))}
      </Inline>

      {/* Current animation info */}
      <Stack alignItems="center" marginBottom={1}>
        <Label color="cyan">{current.name}</Label>
        <MutedText>{current.description}</MutedText>
      </Stack>

      {/* Animation display */}
      <Box
        borderStyle="round"
        borderColor="blue"
        paddingX={1}
        paddingY={1}
        justifyContent="center"
        minHeight={14}
      >
        {current.component}
      </Box>

      {/* Controls */}
      <Inline marginTop={1} justifyContent="center" gap={2}>
        <ShortcutHint keys="←/→" description="navigate" />
        <ShortcutHint keys="[ESC]" description="close" />
        <MutedText>
          {currentIndex + 1}/{ANIMATIONS.length}
        </MutedText>
      </Inline>
    </Stack>
  );
}

// ============================================
// Mini Animation Preview (for status bar)
// ============================================

interface MiniAnimationProps {
  type: AnimationType;
  width?: number;
}

export function MiniAnimation({ type, width = 20 }: MiniAnimationProps) {
  switch (type) {
    case "wave":
      return <Waveform width={width} active />;
    case "gradient":
      return <GradientWave text="8gent" speed={150} />;
    default:
      return null;
  }
}

// ============================================
// Animation List (for help display)
// ============================================

export function AnimationList() {
  return (
    <Stack paddingX={1}>
      <Label color="cyan">Available Animations:</Label>
      {ANIMATIONS.map(anim => (
        <Inline key={anim.id} gap={0}>
          <AppText color="yellow">{anim.id.padEnd(10)}</AppText>
          <MutedText>{anim.description}</MutedText>
        </Inline>
      ))}
      <Box marginTop={1}>
        <MutedText>
          Usage: /animations [name] or /animations all
        </MutedText>
      </Box>
    </Stack>
  );
}

// ============================================
// Export Animation Names
// ============================================

export const ANIMATION_NAMES = ANIMATIONS.map(a => a.id);

export function isValidAnimation(name: string): name is AnimationType {
  return ANIMATION_NAMES.includes(name as AnimationType) || name === "all";
}
