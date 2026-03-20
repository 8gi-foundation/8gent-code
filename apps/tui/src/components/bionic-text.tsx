/**
 * 8gent Code - ADHD Reading Mode
 *
 * Makes text easier to read by bolding the first ~50% of each word.
 * This technique helps the brain recognize words faster by providing
 * "fixation points" that guide the eye.
 *
 * Usage:
 *   <BionicText>Your text here</BionicText>
 *   <BionicText ratio={0.5}>Custom ratio</BionicText>
 */

import React from "react";
import { Text } from "ink";

// ============================================
// Types
// ============================================

interface BionicTextProps {
  children: string;
  /** Ratio of word to bold (0.0 - 1.0), default 0.5 */
  ratio?: number;
  /** Text color for the bold part */
  boldColor?: string;
  /** Text color for the non-bold part */
  normalColor?: string;
  /** Whether to apply dimColor to non-bold part */
  dimNormal?: boolean;
}

interface BionicWordProps {
  word: string;
  ratio: number;
  boldColor?: string;
  normalColor?: string;
  dimNormal?: boolean;
}

// ============================================
// Helper Functions
// ============================================

/**
 * Calculate how many characters to bold based on word length
 */
function getBoldLength(word: string, ratio: number): number {
  // For very short words (1-2 chars), bold the whole thing
  if (word.length <= 2) return word.length;

  // For 3-char words, bold 2
  if (word.length === 3) return 2;

  // For longer words, use the ratio (minimum 1, maximum word.length - 1)
  const boldLen = Math.ceil(word.length * ratio);
  return Math.max(1, Math.min(boldLen, word.length - 1));
}

/**
 * Check if a string is purely punctuation/whitespace
 */
function isPunctuation(str: string): boolean {
  return /^[\s.,!?;:'"()\[\]{}\-–—…]+$/.test(str);
}

// ============================================
// Bionic Word Component
// ============================================

function BionicWord({
  word,
  ratio,
  boldColor,
  normalColor,
  dimNormal = true,
}: BionicWordProps) {
  // Don't process punctuation
  if (isPunctuation(word)) {
    return <Text>{word}</Text>;
  }

  const boldLen = getBoldLength(word, ratio);
  const boldPart = word.slice(0, boldLen);
  const normalPart = word.slice(boldLen);

  return (
    <>
      <Text color={boldColor as any} bold>
        {boldPart}
      </Text>
      <Text color={normalColor as any} dimColor={dimNormal}>
        {normalPart}
      </Text>
    </>
  );
}

// ============================================
// Main Bionic Text Component
// ============================================

export function BionicText({
  children,
  ratio = 0.5,
  boldColor,
  normalColor,
  dimNormal = true,
}: BionicTextProps) {
  // Split text into words and spaces/punctuation
  const tokens = children.split(/(\s+)/);

  return (
    <Text>
      {tokens.map((token, index) => {
        // Preserve whitespace as-is
        if (/^\s+$/.test(token)) {
          return <Text key={index}>{token}</Text>;
        }

        // For words, apply bionic styling
        return (
          <BionicWord
            key={index}
            word={token}
            ratio={ratio}
            boldColor={boldColor}
            normalColor={normalColor}
            dimNormal={dimNormal}
          />
        );
      })}
    </Text>
  );
}

// ============================================
// Bionic Paragraph (handles multi-line text)
// ============================================

interface BionicParagraphProps {
  children: string;
  ratio?: number;
  boldColor?: string;
  normalColor?: string;
  dimNormal?: boolean;
}

export function BionicParagraph({
  children,
  ratio = 0.5,
  boldColor,
  normalColor,
  dimNormal = true,
}: BionicParagraphProps) {
  const lines = children.split("\n");

  return (
    <>
      {lines.map((line, index) => (
        <React.Fragment key={index}>
          <BionicText
            ratio={ratio}
            boldColor={boldColor}
            normalColor={normalColor}
            dimNormal={dimNormal}
          >
            {line}
          </BionicText>
          {index < lines.length - 1 && <Text>{"\n"}</Text>}
        </React.Fragment>
      ))}
    </>
  );
}

// ============================================
// Utility: Convert string to bionic format
// ============================================

/**
 * Returns an array of { text, bold } segments for manual rendering
 */
export function parseBionicText(
  text: string,
  ratio: number = 0.5
): Array<{ text: string; bold: boolean }> {
  const result: Array<{ text: string; bold: boolean }> = [];
  const tokens = text.split(/(\s+)/);

  for (const token of tokens) {
    if (/^\s+$/.test(token) || isPunctuation(token)) {
      result.push({ text: token, bold: false });
    } else {
      const boldLen = getBoldLength(token, ratio);
      result.push({ text: token.slice(0, boldLen), bold: true });
      if (boldLen < token.length) {
        result.push({ text: token.slice(boldLen), bold: false });
      }
    }
  }

  return result;
}

// ============================================
// ADHD Mode Context
// ============================================

import { createContext, useContext } from "react";

interface ADHDModeContextType {
  enabled: boolean;
  ratio: number;
}

export const ADHDModeContext = createContext<ADHDModeContextType>({
  enabled: false,
  ratio: 0.5,
});

export function useADHDMode() {
  return useContext(ADHDModeContext);
}

// ============================================
// Smart Text (auto-applies bionic if ADHD mode on)
// ============================================

interface SmartTextProps {
  children: string;
  color?: string;
}

export function SmartText({ children, color }: SmartTextProps) {
  const { enabled, ratio } = useADHDMode();

  if (!enabled) {
    return <Text color={color as any}>{children}</Text>;
  }

  return (
    <BionicText ratio={ratio} boldColor={color}>
      {children}
    </BionicText>
  );
}

// ============================================
// ADHD Mode Suggestion Message
// ============================================

export const ADHD_MODE_SUGGESTION = `
💡 Hey — try /adhd if you want help locking in.
Bolds the key parts of words so your brain grabs them faster.
`;

export const ADHD_MODE_ENABLED_MSG = `
✦ ADHD Mode On

Nice. This'll help your mind lock in — words hit different now.
Don't worry about it, just focus. I got you.

/adhd off when you're done.
`;

export const ADHD_MODE_DISABLED_MSG = `
ADHD Mode Off

Back to normal. Hit /adhd whenever you need to lock in again.
`;
