/**
 * 8gent Code - Chat Interface
 *
 * iMessage-style layout:
 * - User messages: right-aligned, yellow bubble
 * - 8gent messages: left-aligned, cyan bubble
 * - Tool calls & system: compact collapsible cards
 */

import React, { useState, useEffect, useRef } from "react";
import { Box, Text, useInput, useStdout } from "ink";
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
  maxVisible?: number;
  /** When set, row and bubble width math use this instead of stdout.columns. */
  contentWidth?: number;
  /** When false, skip bubble fade-in delays (matches ^A global anim toggle). */
  showAnimations?: boolean;
}

export function MessageList({
  messages,
  animateTyping = true,
  soundEnabled = false,
  maxVisible = 50,
  contentWidth: contentWidthProp,
  showAnimations = true,
}: MessageListProps) {
  const { stdout } = useStdout();
  const resolvedContentWidth =
    contentWidthProp ?? Math.max(24, (stdout?.columns ?? 80) - 8);

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

  // Only render the most recent messages to prevent scroll jumping.
  // The terminal scrollback handles upward scrolling naturally.
  // This keeps the view pinned to the bottom (latest messages).
  const visibleMessages = messages.length > maxVisible
    ? messages.slice(-maxVisible)
    : messages;

  return (
    <Box flexDirection="column" flexGrow={1} minHeight={0}>
      {visibleMessages.map((message, index) => (
        <MessageItem
          key={message.id}
          message={message}
          isNew={message.id === newMessageId}
          animate={animateTyping}
          soundEnabled={soundEnabled}
          index={index}
          contentWidth={resolvedContentWidth}
          showAnimations={showAnimations}
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
  contentWidth: number;
  showAnimations: boolean;
}

function MessageItem({
  message,
  isNew,
  animate,
  soundEnabled,
  index,
  contentWidth,
  showAnimations,
}: MessageItemProps) {
  const [showContent, setShowContent] = useState(!isNew);
  const [typingComplete, setTypingComplete] = useState(!isNew || !animate);

  const bubbleIndent = Math.max(2, Math.min(12, Math.floor(contentWidth * 0.1)));
  // Outer round border: leave margin vs content column; inner must stay inside border + paddingX + corner slack.
  const bubbleOuterWidth = Math.max(20, contentWidth - bubbleIndent - 8);
  const innerColumnWidth = Math.max(12, bubbleOuterWidth - 6);
  const textWrapWidth = Math.max(8, innerColumnWidth - 2);

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

  // Tool messages render as compact cards (collapsible)
  if (message.role === "tool") {
    const isSuccess = (message as any).toolSuccess !== false;
    const icon = message.content.startsWith("  ✓") ? "✓" : message.content.startsWith("  ✗") ? "✗" : "→";
    const color = icon === "✓" ? "green" : icon === "✗" ? "red" : "blue";
    return (
      <Box marginBottom={1} paddingLeft={2}>
        <Text color={color} dimColor>{icon} </Text>
        <MutedText>{message.content.replace(/^  [✓✗→] /, "").slice(0, 100)}</MutedText>
      </Box>
    );
  }

  // System messages render as subtle centered cards
  if (message.role === "system") {
    if (!showContent) return null;
    const isMultiLine = message.content.includes("\n");
    const fadeWrap = (node: React.ReactNode) =>
      showAnimations ? (
        <FadeIn duration={200} delay={isNew ? index * 20 : 0}>
          {node}
        </FadeIn>
      ) : (
        <Box>{node}</Box>
      );

    if (isMultiLine) {
      // Multi-line system messages (e.g. /evidence, /help) render as a full block
      return fadeWrap(
        <Box flexDirection="column" marginBottom={1} paddingLeft={1}>
          <Text dimColor>{'─'.repeat(3)}</Text>
          <SystemMessageText content={message.content} />
          <Text dimColor>{'─'.repeat(3)}</Text>
        </Box>,
      );
    }
    return fadeWrap(
      <Box justifyContent="center" marginBottom={1}>
        <Text dimColor>{'─'.repeat(3)} </Text>
        <SystemMessageText content={message.content.slice(0, 60)} />
        <Text dimColor> {'─'.repeat(3)}</Text>
      </Box>,
    );
  }

  const isUser = message.role === "user";

  if (!showContent) {
    return (
      <Box marginBottom={1} justifyContent={isUser ? "flex-end" : "flex-start"}>
        <MutedText>...</MutedText>
      </Box>
    );
  }

  const bubble = (
      <Box
        flexDirection="column"
        alignItems={isUser ? "flex-end" : "flex-start"}
        marginBottom={1}
        width={contentWidth}
      >
        {/* Sender label */}
        <Box>
          {isUser ? (
            <MutedText>{formatTime(message.timestamp)} </MutedText>
          ) : (
            <Label color="cyan">◆ 8gent </Label>
          )}
          {isUser ? (
            <Label color="yellow">You</Label>
          ) : (
            <MutedText>{formatTime(message.timestamp)}</MutedText>
          )}
        </Box>

        {/* Chat bubble */}
        <Box
          borderStyle="round"
          borderColor={isUser ? "yellow" : "cyan"}
          paddingX={1}
          paddingY={1}
          marginLeft={isUser ? bubbleIndent : 0}
          marginRight={isUser ? 0 : bubbleIndent}
          flexShrink={1}
          width={bubbleOuterWidth}
        >
          <Box
            flexShrink={1}
            flexDirection="column"
            width={innerColumnWidth}
          >
            <MessageContent
              content={message.content}
              role={message.role}
              isNew={isNew}
              animate={animate}
              onTypingComplete={() => setTypingComplete(true)}
              wrapWidth={textWrapWidth}
            />
          </Box>
        </Box>
      </Box>
  );

  return showAnimations ? (
    <FadeIn duration={200} delay={isNew ? index * 20 : 0}>
      {bubble}
    </FadeIn>
  ) : (
    bubble
  );
}

interface MessageContentProps {
  content: string;
  role: "user" | "assistant" | "system" | "tool";
  isNew: boolean;
  animate: boolean;
  onTypingComplete: () => void;
  wrapWidth: number;
}

function MessageContent({
  content,
  role,
  isNew,
  animate,
  onTypingComplete,
  wrapWidth,
}: MessageContentProps) {
  const { enabled: adhdMode } = useADHDMode();

  // Only animate typing for new assistant messages
  const shouldAnimate = isNew && animate && role === "assistant";

  if (shouldAnimate) {
    // Use word-by-word for longer content, character for shorter
    if (content.length > 200) {
      return (
        <Box width={wrapWidth}>
          <WordByWord text={content} speed={30} onComplete={onTypingComplete} />
        </Box>
      );
    }
    return (
      <Box width={wrapWidth}>
        <TypingText
          text={content}
          speed={12}
          onComplete={onTypingComplete}
          cursor={true}
        />
      </Box>
    );
  }

  // Check for code blocks and format accordingly
  if (content.includes("```")) {
    return (
      <FormattedContent content={content} adhdMode={adhdMode} wrapWidth={wrapWidth} />
    );
  }

  // Apply bionic reading if ADHD mode is enabled
  if (adhdMode) {
    return (
      <Box width={wrapWidth}>
        <BionicText>{content}</BionicText>
      </Box>
    );
  }

  return (
    <Box width={wrapWidth}>
      <AppText wrap="wrap">{content}</AppText>
    </Box>
  );
}

// Format content with code blocks
function FormattedContent({
  content,
  adhdMode = false,
  wrapWidth,
}: {
  content: string;
  adhdMode?: boolean;
  wrapWidth: number;
}) {
  const parts = content.split(/(```[\s\S]*?```)/);

  return (
    <Box flexDirection="column" width={wrapWidth}>
      {parts.map((part, index) => {
        if (part.startsWith("```")) {
          // Extract language and code
          const match = part.match(/```(\w+)?\n?([\s\S]*?)```/);
          if (match) {
            const [, language, code] = match;
            const fenceInner = Math.max(8, wrapWidth - 8);
            return (
              <Box
                key={index}
                flexDirection="column"
                borderStyle="round"
                borderColor="blue"
                paddingX={1}
                paddingY={1}
                marginY={1}
                flexShrink={1}
                width={wrapWidth}
              >
                {language && (
                  <MutedText>
                    {language}
                  </MutedText>
                )}
                <Box width={fenceInner}>
                  <Text color="green" wrap="wrap">
                    {code.trim()}
                  </Text>
                </Box>
              </Box>
            );
          }
        }
        // Apply bionic reading to non-code parts if ADHD mode is enabled
        if (adhdMode) {
          return (
            <Box key={index} width={wrapWidth}>
              <BionicText>{part}</BionicText>
            </Box>
          );
        }
        return (
          <Box key={index} width={wrapWidth}>
            <AppText wrap="wrap">{part}</AppText>
          </Box>
        );
      })}
    </Box>
  );
}

function SystemMessageText({ content }: { content: string }) {
  // System messages are structured (commands, help) — never bionic them
  return <MutedText>{content}</MutedText>;
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

// Compact message item for dense view
export function CompactMessageItem({ message }: { message: Message }) {
  const roleIcons: Record<string, string> = {
    user: "→",
    assistant: "←",
    system: "•",
    tool: " ",
  };

  const roleColors: Record<string, "yellow" | "cyan" | "green" | "magenta"> = {
    user: "yellow",
    assistant: "cyan",
    system: "cyan",
    tool: "magenta",
  };

  if (message.role === "tool") {
    return (
      <Box paddingLeft={2}>
        <MutedText>{message.content}</MutedText>
      </Box>
    );
  }

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
