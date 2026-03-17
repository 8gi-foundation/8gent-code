/**
 * 8gent CLUI -- Message List Component
 *
 * Adapted from apps/tui/src/components/message-list.tsx for React DOM.
 *
 * iMessage-style layout:
 * - User messages: right-aligned, warning-colored border
 * - Agent messages: left-aligned, accent-colored border
 * - Tool calls: compact inline cards with success/failure indicators
 * - System messages: centered, muted dividers
 */

import React, { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Message } from "../stores/session-store";

// ── Message List ─────────────────────────────────────────────────────

interface MessageListProps {
  messages: Message[];
  maxVisible?: number;
}

export function MessageList({ messages, maxVisible = 100 }: MessageListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages.length]);

  const visibleMessages =
    messages.length > maxVisible ? messages.slice(-maxVisible) : messages;

  if (visibleMessages.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted text-sm">
        Start a conversation with the 8gent agent.
      </div>
    );
  }

  return (
    <div ref={scrollRef} className="flex flex-col gap-3">
      {visibleMessages.map((message) => (
        <MessageItem key={message.id} message={message} />
      ))}
    </div>
  );
}

// ── Message Item Router ──────────────────────────────────────────────

function MessageItem({ message }: { message: Message }) {
  if (message.role === "tool") {
    return <ToolMessage message={message} />;
  }

  if (message.role === "system") {
    return <SystemMessage message={message} />;
  }

  const isUser = message.role === "user";
  return <ChatBubble message={message} isUser={isUser} />;
}

// ── Chat Bubble ──────────────────────────────────────────────────────

function ChatBubble({
  message,
  isUser,
}: {
  message: Message;
  isUser: boolean;
}) {
  return (
    <div
      className={`
        flex flex-col animate-fade-in
        ${isUser ? "items-end" : "items-start"}
      `}
    >
      {/* Sender label */}
      <div className="flex items-center gap-1.5 mb-1">
        {isUser ? (
          <>
            <span className="text-muted text-xs">
              {formatTime(message.timestamp)}
            </span>
            <span className="text-8-yellow text-xs font-bold">You</span>
          </>
        ) : (
          <>
            <span className="text-accent text-xs font-bold">
              &#x25C6; 8gent
            </span>
            <span className="text-muted text-xs">
              {formatTime(message.timestamp)}
            </span>
          </>
        )}
      </div>

      {/* Bubble */}
      <div
        className={`
          relative max-w-[85%] px-3 py-2 rounded-lg
          border text-sm leading-relaxed
          ${isUser
            ? "border-8-yellow/40 bg-8-yellow/5 ml-12"
            : "border-accent/40 bg-accent/5 mr-12"
          }
        `}
      >
        <MessageContent content={message.content} />

        {/* Streaming cursor */}
        {message.isStreaming && (
          <span className="inline-block w-1.5 h-4 bg-accent animate-pulse ml-0.5 align-text-bottom" />
        )}
      </div>
    </div>
  );
}

// ── Message Content (Markdown) ───────────────────────────────────────

function MessageContent({ content }: { content: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        p: ({ children }) => (
          <p className="whitespace-pre-wrap mb-2 last:mb-0">{children}</p>
        ),
        code: ({ className, children, ...props }) => {
          const match = /language-(\w+)/.exec(className || "");
          const isInline = !match;

          if (isInline) {
            return (
              <code
                className="px-1 py-0.5 rounded bg-surface-secondary text-accent text-xs"
                {...props}
              >
                {children}
              </code>
            );
          }

          return (
            <CodeBlock language={match ? match[1] : undefined}>
              {String(children).replace(/\n$/, "")}
            </CodeBlock>
          );
        },
        pre: ({ children }) => <>{children}</>,
        a: ({ href, children }) => (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-info underline underline-offset-2 hover:text-accent transition-colors"
          >
            {children}
          </a>
        ),
        ul: ({ children }) => (
          <ul className="list-disc pl-4 mb-2 last:mb-0">{children}</ul>
        ),
        ol: ({ children }) => (
          <ol className="list-decimal pl-4 mb-2 last:mb-0">{children}</ol>
        ),
        li: ({ children }) => <li className="mb-0.5">{children}</li>,
        strong: ({ children }) => (
          <strong className="font-bold text-accent">{children}</strong>
        ),
        em: ({ children }) => <em className="italic">{children}</em>,
        blockquote: ({ children }) => (
          <blockquote className="border-l-2 border-accent/40 pl-3 my-2 text-muted italic">
            {children}
          </blockquote>
        ),
        table: ({ children }) => (
          <div className="overflow-x-auto my-2">
            <table className="text-xs border-collapse border border-subtle w-full">
              {children}
            </table>
          </div>
        ),
        th: ({ children }) => (
          <th className="border border-subtle px-2 py-1 text-left bg-surface-secondary text-accent font-bold">
            {children}
          </th>
        ),
        td: ({ children }) => (
          <td className="border border-subtle px-2 py-1">{children}</td>
        ),
        hr: () => <hr className="border-subtle my-3" />,
      }}
    >
      {content}
    </ReactMarkdown>
  );
}

// ── Code Block with Copy ─────────────────────────────────────────────

function CodeBlock({
  language,
  children,
}: {
  language?: string;
  children: string;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(children).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div className="rounded border border-info/30 bg-surface-secondary overflow-x-auto my-2 group relative">
      <div className="flex items-center justify-between px-3 py-1 border-b border-subtle">
        <span className="text-xs text-muted">{language || "text"}</span>
        <button
          onClick={handleCopy}
          className="
            text-xs text-muted hover:text-accent
            opacity-0 group-hover:opacity-100
            transition-opacity duration-150
          "
        >
          {copied ? "\u2713 Copied" : "Copy"}
        </button>
      </div>
      <pre className="px-3 py-2 text-xs text-success overflow-x-auto">
        <code>{children}</code>
      </pre>
    </div>
  );
}

// ── Tool Message ─────────────────────────────────────────────────────

function ToolMessage({ message }: { message: Message }) {
  const isSuccess = message.toolSuccess !== false;
  const icon = isSuccess ? "\u2713" : "\u2717";
  const colorClass = isSuccess ? "text-success" : "text-danger";

  // Strip leading icons from content for clean display
  const cleanContent = message.content.replace(/^\s*[✓✗→]\s*/, "").slice(0, 120);

  return (
    <div className="flex items-start gap-1.5 pl-3 py-0.5 animate-fade-in">
      <span className={`${colorClass} text-xs opacity-70`}>{icon}</span>
      <span className="text-muted text-xs truncate">{cleanContent}</span>
    </div>
  );
}

// ── System Message ───────────────────────────────────────────────────

function SystemMessage({ message }: { message: Message }) {
  const isMultiLine = message.content.includes("\n");

  if (isMultiLine) {
    return (
      <div className="flex flex-col gap-1 px-3 py-2 animate-fade-in">
        <div className="text-muted text-xs">{"---"}</div>
        <div className="text-muted text-xs whitespace-pre-wrap">
          {message.content}
        </div>
        <div className="text-muted text-xs">{"---"}</div>
      </div>
    );
  }

  return (
    <div className="flex justify-center py-1 animate-fade-in">
      <span className="text-muted text-xs">
        {"---"} {message.content.slice(0, 80)} {"---"}
      </span>
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────

function formatTime(date: Date): string {
  return date.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
  });
}
