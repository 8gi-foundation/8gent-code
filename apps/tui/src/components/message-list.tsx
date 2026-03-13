/**
 * 8gent Code - Animated Message List Component
 *
 * Features:
 * - Fade in animation for new messages
 * - Typing animation for assistant responses
 * - Smooth transitions between messages
 */

import React, { useState, useEffect, useRef } from "react";
import { Box, Text } from "ink";
import type { Message } from "../app.js";
import { TypingText, WordByWord } from "./typing-text.js";
import { FadeIn, PopIn, GlowText } from "./fade-transition.js";
import { useCompletionSound } from "./sound-effects.js";
import { useADHDMode, BionicText } from "./bionic-text.js";
import { AppText, MutedText, Label, Stack } from './primitives/index.js';

interface MessageListProps {
  messages: Message[];
  animateTyping?: boolean;
  soundEnabled?: boolean;
}

export function MessageList({
  messages,
  animateTyping = true,
  soundEnabled = false,
}: MessageListProps) {
  const prevCountRef = useRef(messages.length);
  const [newMessageId, setNewMessageId] = useState<string | null>(null);

  // Track new messages for animation
  useEffect(() => {
    if (messages.length > prevCountRef.current) {
      const newMessage = messages[messages.length - 1];
      setNewMessageId(newMessage.id);
    }
    prevCountRef.current = messages.length;
  }, [messages]);

  return (
    <Box flexDirection="column" flexGrow={1}>
      {messages.map((message, index) => (
        <MessageItem
          key={message.id}
          message={message}
          isNew={message.id === newMessageId}
          animate={animateTyping}
          soundEnabled={soundEnabled}
          index={index}
        />
      ))}
    </Box>
  );
}

interface MessageItemProps {
  message: Message;
  isNew: boolean;
  animate: boolean;
  soundEnabled: boolean;
  index: number;
}

function MessageItem({
  message,
  isNew,
  animate,
  soundEnabled,
  index,
}: MessageItemProps) {
  const [showContent, setShowContent] = useState(!isNew);
  const [typingComplete, setTypingComplete] = useState(!isNew || !animate);

  // Play sound on completion for assistant messages
  useCompletionSound(
    typingComplete && message.role === "assistant" && isNew,
    soundEnabled
  );

  // Fade in the message header
  useEffect(() => {
    if (isNew) {
      const timeout = setTimeout(() => setShowContent(true), 50);
      return () => clearTimeout(timeout);
    }
  }, [isNew]);

  const roleConfig = {
    user: {
      color: "yellow" as const,
      label: "You",
      icon: "▸",
      labelColor: "#FFD700",
    },
    assistant: {
      color: "cyan" as const,
      label: "8gent",
      icon: "◆",
      labelColor: "#00FFFF",
    },
    system: {
      color: "gray" as const,
      label: "System",
      icon: "●",
      labelColor: "#888888",
    },
  };

  const config = roleConfig[message.role];

  if (!showContent) {
    return (
      <Box marginBottom={1}>
        <MutedText>
          ...
        </MutedText>
      </Box>
    );
  }

  return (
    <FadeIn duration={200} delay={isNew ? index * 20 : 0}>
      <Stack marginBottom={1}>
        {/* Message header */}
        <Box>
          <PopIn delay={isNew ? 50 : 0}>
            <Text color={config.color}>{config.icon} </Text>
          </PopIn>
          <Label color={config.color}>
            {config.label}
          </Label>
          <MutedText>
            {" "}
            {formatTime(message.timestamp)}
          </MutedText>
        </Box>

        {/* Message content */}
        <Box paddingLeft={2}>
          <MessageContent
            content={message.content}
            role={message.role}
            isNew={isNew}
            animate={animate}
            onTypingComplete={() => setTypingComplete(true)}
          />
        </Box>
      </Stack>
    </FadeIn>
  );
}

interface MessageContentProps {
  content: string;
  role: "user" | "assistant" | "system";
  isNew: boolean;
  animate: boolean;
  onTypingComplete: () => void;
}

function MessageContent({
  content,
  role,
  isNew,
  animate,
  onTypingComplete,
}: MessageContentProps) {
  const { enabled: adhdMode } = useADHDMode();

  // Only animate typing for new assistant messages
  const shouldAnimate = isNew && animate && role === "assistant";

  if (shouldAnimate) {
    // Use word-by-word for longer content, character for shorter
    if (content.length > 200) {
      return (
        <WordByWord text={content} speed={30} onComplete={onTypingComplete} />
      );
    }
    return (
      <TypingText
        text={content}
        speed={12}
        onComplete={onTypingComplete}
        cursor={true}
      />
    );
  }

  // Check for code blocks and format accordingly
  if (content.includes("```")) {
    return <FormattedContent content={content} adhdMode={adhdMode} />;
  }

  // Apply bionic reading if ADHD mode is enabled
  if (adhdMode) {
    return <BionicText>{content}</BionicText>;
  }

  return <AppText wrap="wrap">{content}</AppText>;
}

// Format content with code blocks
function FormattedContent({ content, adhdMode = false }: { content: string; adhdMode?: boolean }) {
  const parts = content.split(/(```[\s\S]*?```)/);

  return (
    <Box flexDirection="column">
      {parts.map((part, index) => {
        if (part.startsWith("```")) {
          // Extract language and code
          const match = part.match(/```(\w+)?\n?([\s\S]*?)```/);
          if (match) {
            const [, language, code] = match;
            return (
              <Box
                key={index}
                flexDirection="column"
                borderStyle="round"
                borderColor="blue"
                paddingX={1}
                marginY={1}
              >
                {language && (
                  <MutedText>
                    {language}
                  </MutedText>
                )}
                <Text color="green">{code.trim()}</Text>
              </Box>
            );
          }
        }
        // Apply bionic reading to non-code parts if ADHD mode is enabled
        if (adhdMode) {
          return <BionicText key={index}>{part}</BionicText>;
        }
        return (
          <AppText key={index} wrap="wrap">
            {part}
          </AppText>
        );
      })}
    </Box>
  );
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

// Compact message item for dense view
export function CompactMessageItem({ message }: { message: Message }) {
  const roleIcons = {
    user: "→",
    assistant: "←",
    system: "•",
  };

  const roleColors = {
    user: "yellow",
    assistant: "cyan",
    system: "gray",
  } as const;

  return (
    <Box>
      <Text color={roleColors[message.role]}>{roleIcons[message.role]} </Text>
      <AppText wrap="wrap">{message.content}</AppText>
    </Box>
  );
}

// Streaming message for real-time responses
interface StreamingMessageProps {
  chunks: string[];
  isComplete: boolean;
}

export function StreamingMessage({ chunks, isComplete }: StreamingMessageProps) {
  const [displayedChunks, setDisplayedChunks] = useState(0);

  useEffect(() => {
    if (displayedChunks < chunks.length) {
      const timeout = setTimeout(() => {
        setDisplayedChunks((prev) => prev + 1);
      }, 30);
      return () => clearTimeout(timeout);
    }
  }, [chunks.length, displayedChunks]);

  return (
    <Stack marginBottom={1}>
      <Box>
        <Label color="cyan">
          ◆ 8gent
        </Label>
        {!isComplete && (
          <Text color="cyan"> ▌</Text>
        )}
      </Box>
      <Box paddingLeft={2}>
        <AppText wrap="wrap">{chunks.slice(0, displayedChunks).join("")}</AppText>
      </Box>
    </Stack>
  );
}
