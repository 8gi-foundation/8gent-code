/**
 * 8gent Code - Typing Text Animation
 *
 * Character-by-character text reveal for that authentic CLI feel
 */

import React, { useState, useEffect, useCallback } from "react";
import { Box, Text } from "ink";

interface TypingTextProps {
  text: string;
  speed?: number; // ms per character
  color?: string;
  onComplete?: () => void;
  cursor?: boolean;
  cursorChar?: string;
}

export function TypingText({
  text,
  speed = 15,
  color = "white",
  onComplete,
  cursor = true,
  cursorChar = "▌",
}: TypingTextProps) {
  const [displayedText, setDisplayedText] = useState("");
  const [showCursor, setShowCursor] = useState(true);
  const [isComplete, setIsComplete] = useState(false);

  // Typing effect
  useEffect(() => {
    if (displayedText.length < text.length) {
      const timeout = setTimeout(() => {
        setDisplayedText(text.slice(0, displayedText.length + 1));
      }, speed);
      return () => clearTimeout(timeout);
    } else {
      setIsComplete(true);
      onComplete?.();
    }
  }, [displayedText, text, speed, onComplete]);

  // Cursor blink effect
  useEffect(() => {
    if (!cursor) return;

    const interval = setInterval(() => {
      setShowCursor((prev) => !prev);
    }, 530);

    return () => clearInterval(interval);
  }, [cursor]);

  return (
    <Text color={color}>
      {displayedText}
      {cursor && !isComplete && (
        <Text color="cyan">{showCursor ? cursorChar : " "}</Text>
      )}
    </Text>
  );
}

// Streaming text that accepts new chunks
interface StreamingTextProps {
  chunks: string[];
  speed?: number;
  color?: string;
}

export function StreamingText({
  chunks,
  speed = 10,
  color = "white",
}: StreamingTextProps) {
  const [currentChunkIndex, setCurrentChunkIndex] = useState(0);
  const [displayedText, setDisplayedText] = useState("");
  const [charIndex, setCharIndex] = useState(0);

  useEffect(() => {
    if (currentChunkIndex >= chunks.length) return;

    const currentChunk = chunks[currentChunkIndex];

    if (charIndex < currentChunk.length) {
      const timeout = setTimeout(() => {
        setDisplayedText((prev) => prev + currentChunk[charIndex]);
        setCharIndex((prev) => prev + 1);
      }, speed);
      return () => clearTimeout(timeout);
    } else {
      // Move to next chunk
      setCurrentChunkIndex((prev) => prev + 1);
      setCharIndex(0);
    }
  }, [chunks, currentChunkIndex, charIndex, speed]);

  return <Text color={color}>{displayedText}</Text>;
}

// Typewriter with word-by-word animation
interface WordByWordProps {
  text: string;
  speed?: number; // ms per word
  color?: string;
  onComplete?: () => void;
}

export function WordByWord({
  text,
  speed = 50,
  color = "white",
  onComplete,
}: WordByWordProps) {
  const words = text.split(" ");
  const [wordIndex, setWordIndex] = useState(0);

  useEffect(() => {
    if (wordIndex < words.length) {
      const timeout = setTimeout(() => {
        setWordIndex((prev) => prev + 1);
      }, speed);
      return () => clearTimeout(timeout);
    } else {
      onComplete?.();
    }
  }, [wordIndex, words.length, speed, onComplete]);

  return (
    <Text color={color} wrap="wrap">
      {words.slice(0, wordIndex).join(" ")}
      {wordIndex < words.length && <Text color="cyan">▌</Text>}
    </Text>
  );
}

// Code block with syntax-aware typing
interface CodeTypingProps {
  code: string;
  language?: string;
  speed?: number;
}

export function CodeTyping({ code, language, speed = 8 }: CodeTypingProps) {
  const [displayedCode, setDisplayedCode] = useState("");
  const [lineIndex, setLineIndex] = useState(0);
  const [charIndex, setCharIndex] = useState(0);

  const lines = code.split("\n");

  useEffect(() => {
    if (lineIndex >= lines.length) return;

    const currentLine = lines[lineIndex];

    if (charIndex < currentLine.length) {
      const timeout = setTimeout(() => {
        setDisplayedCode((prev) => prev + currentLine[charIndex]);
        setCharIndex((prev) => prev + 1);
      }, speed);
      return () => clearTimeout(timeout);
    } else {
      // Move to next line
      setDisplayedCode((prev) => prev + "\n");
      setLineIndex((prev) => prev + 1);
      setCharIndex(0);
    }
  }, [lines, lineIndex, charIndex, speed]);

  return (
    <Box
      borderStyle="round"
      borderColor="blue"
      paddingX={1}
      flexDirection="column"
    >
      {language && (
        <Box marginBottom={1}>
          <Text dimColor>
            {language}
          </Text>
        </Box>
      )}
      <Text color="green">{displayedCode}</Text>
    </Box>
  );
}
