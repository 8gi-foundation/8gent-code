/**
 * 8gent Code - Sound Effects
 *
 * Terminal beeps and sound feedback
 */

import { useEffect } from "react";

// Terminal bell character
const BELL = "\x07";

// Sound effect types
type SoundType = "beep" | "success" | "error" | "notification" | "typing";

interface SoundConfig {
  pattern: number[]; // Array of delays between beeps
  enabled: boolean;
}

// Sound patterns (delays in ms)
const SOUND_PATTERNS: Record<SoundType, number[]> = {
  beep: [0], // Single beep
  success: [0, 100], // Two quick beeps
  error: [0, 100, 100], // Three beeps
  notification: [0, 200, 200, 200], // Four spaced beeps
  typing: [0], // Single beep for key press
};

// Play a single beep
function beep(): void {
  process.stdout.write(BELL);
}

// Play a sound pattern
export function playSound(type: SoundType): void {
  const pattern = SOUND_PATTERNS[type];

  pattern.forEach((delay, index) => {
    setTimeout(() => {
      beep();
    }, pattern.slice(0, index).reduce((a, b) => a + b, 0) + delay);
  });
}

// Hook to play sound on mount
interface UseSoundProps {
  type: SoundType;
  enabled?: boolean;
  condition?: boolean;
}

export function useSound({
  type,
  enabled = true,
  condition = true,
}: UseSoundProps): void {
  useEffect(() => {
    if (enabled && condition) {
      playSound(type);
    }
  }, [type, enabled, condition]);
}

// Hook for completion sound
export function useCompletionSound(isComplete: boolean, enabled = true): void {
  useEffect(() => {
    if (isComplete && enabled) {
      playSound("success");
    }
  }, [isComplete, enabled]);
}

// Hook for error sound
export function useErrorSound(hasError: boolean, enabled = true): void {
  useEffect(() => {
    if (hasError && enabled) {
      playSound("error");
    }
  }, [hasError, enabled]);
}

// Sound manager for global control
class SoundManager {
  private static instance: SoundManager;
  private enabled: boolean = true;
  private volume: number = 1; // Not actually used for terminal beeps, but for future

  private constructor() {}

  static getInstance(): SoundManager {
    if (!SoundManager.instance) {
      SoundManager.instance = new SoundManager();
    }
    return SoundManager.instance;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  play(type: SoundType): void {
    if (this.enabled) {
      playSound(type);
    }
  }

  beep(): void {
    if (this.enabled) {
      beep();
    }
  }

  // Play success melody
  success(): void {
    this.play("success");
  }

  // Play error sound
  error(): void {
    this.play("error");
  }

  // Play notification
  notify(): void {
    this.play("notification");
  }
}

export const soundManager = SoundManager.getInstance();

// Component that plays sound on render
interface SoundEffectProps {
  type: SoundType;
  play?: boolean;
}

export function SoundEffect({ type, play = true }: SoundEffectProps): null {
  useEffect(() => {
    if (play) {
      playSound(type);
    }
  }, [type, play]);

  return null;
}

// Typing sound effect (for each keystroke)
let lastTypingSound = 0;
const TYPING_SOUND_THROTTLE = 50; // ms

export function playTypingSound(): void {
  const now = Date.now();
  if (now - lastTypingSound > TYPING_SOUND_THROTTLE) {
    beep();
    lastTypingSound = now;
  }
}
