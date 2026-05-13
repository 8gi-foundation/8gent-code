/**
 * 8gent Code - Chat Interface
 *
 * Left-bar style, alignment-neutral (both roles left-aligned):
 * - User messages: orange left-bar, "You" label
 * - 8gent messages: teal left-bar (latest assistant) or muted (older), "8gent" label
 * - Footer (assistant only, when metadata present): "Xs · N tok" in muted
 * - Tool calls: NEVER rendered in chat — they live in the ^B processes panel.
 *   The agent's in-flight activity surfaces via the status bar's plan verb.
 * - System messages: compact centered hints (single line) or blocks (multi-line)
 *
 * Width math: outer Box uses contentWidth; borderLeft consumes 1 col,
 * paddingLeft={1} consumes 1 col → inner content gets contentWidth-2.
 * The bubble width and textWrapWidth each subtract 2 to keep the existing
 * forceBreakLongRuns guarantees intact.
 *
 * Why the bar instead of a full bordered box: adjacent borders can fuse
 * at narrow widths (the hitsRY bug, PR #2407). marginBottom={1} between
 * turns + only-left border avoids any shared edge.
 *
 * Overflow protection: long unbreakable runs (paths, URLs, hashes) are
 * force-broken at wrapWidth before handing to Ink, so nothing can escape
 * its column.
 */

import { Box, Text, useInput, useStdout } from "ink";
import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Message } from "../app.js";
import { useMouseScroll } from "../hooks/useMouseScroll.js";
import { t } from "../theme.js";
import { BionicText, useADHDMode } from "./bionic-text.js";
import { FadeIn, GlowText, PopIn } from "./fade-transition.js";
import { AppText, Label, MutedText } from "./primitives/AppText.js";
import { Stack } from "./primitives/Stack.js";
import { useCompletionSound } from "./sound-effects.js";
import { TypingText, WordByWord } from "./typing-text.js";

/**
 * Force-break any run of non-whitespace longer than `width` chars.
 * Ink's wrap="wrap" only splits on whitespace, so long paths / URLs / hashes
 * can overflow their container. This inserts hard line breaks inside the
 * offending token so the normal wrap picks it up.
 *
 * Hermes pattern: prefer soft break points first. Real prose tokens that
 * exceed `width` are usually compounds joined by `-`, `/`, `_`, `.` — splitting
 * at those boundaries reads naturally. Falling through to hard mid-character
 * breaks is reserved for hashes/URLs with no natural seam. We also enforce
 * a sane minimum width (8) so we never produce 4-char fragments that mash
 * back together visually as `need-whthink`.
 */
// Exposed under a stable name for the smoke harness so we can lock in the
// soft-seam behaviour without exporting the React module's identity.
const breakLongTokensForTest = (text: string, width: number): string =>
	breakLongTokens(text, width);

function breakLongTokens(text: string, width: number): string {
	const hardBreakWidth = Math.max(8, width);
	if (text.length <= hardBreakWidth) return text;
	return text
		.split("\n")
		.map((line) => {
			const out: string[] = [];
			for (const token of line.split(/(\s+)/)) {
				if (!token) continue;
				if (token.length > hardBreakWidth && !/^\s+$/.test(token)) {
					// First, try soft breaks at natural seams (-, /, _, .).
					// Push each segment plus its separator on its own line if it
					// would fit. This keeps `feature/long-branch-name` readable
					// instead of mashing characters together.
					const seamSplit = token.split(/([-/_.])/);
					let buf = "";
					const flush = () => {
						if (!buf) return;
						out.push(buf);
						buf = "";
					};
					for (const part of seamSplit) {
						if (!part) continue;
						if ((buf + part).length > hardBreakWidth) {
							if (buf) {
								flush();
								out.push("\n");
							}
							// Part itself may still exceed width (e.g. a long hash).
							// Hard-break it character-wise as a last resort.
							if (part.length > hardBreakWidth) {
								for (let i = 0; i < part.length; i += hardBreakWidth) {
									out.push(part.slice(i, i + hardBreakWidth));
									if (i + hardBreakWidth < part.length) out.push("\n");
								}
							} else {
								buf = part;
							}
						} else {
							buf += part;
						}
					}
					flush();
				} else {
					out.push(token);
				}
			}
			return out.join("");
		})
		.join("\n");
}

interface MessageListProps {
	messages: Message[];
	animateTyping?: boolean;
	soundEnabled?: boolean;
	/** Legacy cap on rendered messages. Acts as a final safety lid even when
	 *  rowBudget is also provided. Default 200 — large because rowBudget now
	 *  does the real clipping. */
	maxVisible?: number;
	/** When set, row and bubble width math use this instead of stdout.columns. */
	contentWidth?: number;
	/** Available terminal rows for the list. Drives the slice math so the
	 *  rendered tree never exceeds the container — which is what was causing
	 *  the streaming overlap artifacts. */
	rowBudget?: number;
	/** When false, skip bubble fade-in delays (matches ^A global anim toggle). */
	showAnimations?: boolean;
	/** Disable mouse-wheel + keyboard scroll capture (e.g. another modal owns input). */
	scrollEnabled?: boolean;
}

/**
 * Estimate how many terminal rows a message renders into.
 * Used to slice the visible window so the rendered tree's total height never
 * exceeds the container — Ink's diff renderer leaves stale chars when content
 * shrinks, so we MUST clip in our own code, not rely on overflow:hidden.
 *
 * Overhead per message: 1 header row + 1 marginBottom; assistant footer adds 1.
 * Body: count wrapped lines for each line of content.
 */
function estimateMessageRows(message: Message, wrapWidth: number): number {
	if (message.role === "tool") return 0;
	const w = Math.max(1, wrapWidth);
	const safe = breakLongTokens(message.content, w);
	let rows = 0;
	for (const line of safe.split("\n")) {
		rows += Math.max(1, Math.ceil(line.length / w));
	}
	if (message.role === "system") {
		// Multi-line system messages get top/bottom ─── separators (2 extra rows).
		return rows + (message.content.includes("\n") ? 2 : 0) + 1;
	}
	// 1 header + 1 marginBottom; assistant with metadata = 1 footer too.
	const overhead =
		message.role === "assistant" &&
		typeof message.latencyMs === "number" &&
		typeof message.tokens === "number"
			? 3
			: 2;
	return rows + overhead;
}

export function MessageList({
	messages,
	animateTyping = true,
	soundEnabled = false,
	maxVisible = 200,
	contentWidth: contentWidthProp,
	rowBudget,
	showAnimations = true,
	scrollEnabled = true,
}: MessageListProps) {
	const { stdout } = useStdout();
	const resolvedContentWidth = contentWidthProp ?? Math.max(24, (stdout?.columns ?? 80) - 8);
	// Width used to estimate wrapped line count — matches MessageItem's body
	// width math (contentWidth - 2 outer chrome, * 0.78 bubble, - 2 slack).
	const wrapBudget = Math.max(8, Math.floor((resolvedContentWidth - 2) * 0.78) - 2);
	// Default rowBudget: tall enough that small chats render fully, low enough
	// that long sessions still clip on a typical terminal (80x24).
	const resolvedRowBudget = Math.max(4, rowBudget ?? Math.max(8, (stdout?.rows ?? 24) - 10));

	const prevCountRef = useRef(messages.length);
	const [newMessageId, setNewMessageId] = useState<string | null>(null);
	// Messages we've already kicked off the typing animation for. Once an ID
	// lands here, future remounts (caused by scrolling out of the slice and
	// back) render statically — pages stay stable like a book.
	const animatedIdsRef = useRef<Set<string>>(new Set());

	// Tool messages never render in chat — they flow to the ^B processes panel.
	const chatMessages = messages.filter((m) => m.role !== "tool");

	// Per-message estimated row counts. Cheap to compute; no memo needed.
	const rowEstimates = chatMessages.map((m) => estimateMessageRows(m, wrapBudget));

	// --- Scroll state (web-style auto-pin + content-anchored offset) ---
	// scrollOffset = messages held back from the bottom. autoScrollRef tracks
	// whether the user is pinned to the live edge.
	const [scrollOffset, setScrollOffset] = useState(0);
	const autoScrollRef = useRef(true);

	const total = chatMessages.length;

	// Walk back from the latest message, fitting as many as the row budget
	// allows. This is the single source of truth for "what fits on screen".
	// It also tells us the deepest valid scrollOffset — the offset where the
	// oldest message becomes the bottom of the window.
	const computeWindow = useCallback(
		(offsetFromBottom: number) => {
			const sliceEnd = Math.max(1, total - offsetFromBottom);
			let acc = 0;
			let startIdx = sliceEnd;
			for (let i = sliceEnd - 1; i >= 0; i--) {
				const r = rowEstimates[i] ?? 0;
				// Always include at least one message, even if it overflows alone.
				if (acc + r > resolvedRowBudget && startIdx < sliceEnd) break;
				acc += r;
				startIdx = i;
			}
			return { startIdx, sliceEnd };
		},
		[total, rowEstimates, resolvedRowBudget],
	);

	// maxScrollOffset: the deepest scroll position where message 0 is still
	// the top of the window. Find the smallest K where rows[0..K] would
	// overflow the budget — that K becomes the sliceEnd at max scroll, and
	// offset = total - K. If all messages fit, no scrolling needed.
	const maxScrollOffset = (() => {
		if (total === 0) return 0;
		let acc = 0;
		for (let i = 0; i < total; i++) {
			acc += rowEstimates[i] ?? 0;
			if (acc > resolvedRowBudget) {
				// msg 0 alone exceeds the budget — irreducible, no real scrolling.
				if (i === 0) return 0;
				// rows[0..i-1] fit; msg i would push us over. sliceEnd = i.
				return Math.max(0, total - i);
			}
		}
		return 0;
	})();
	const clampedOffset = Math.min(scrollOffset, maxScrollOffset);

	const scrollBy = useCallback(
		(deltaMessages: number) => {
			setScrollOffset((prev) => {
				const next = Math.max(0, Math.min(prev + deltaMessages, maxScrollOffset));
				autoScrollRef.current = next === 0;
				return next;
			});
		},
		[maxScrollOffset],
	);

	// Keyboard: shift+arrows (plain arrows are owned by the input field).
	useInput(
		(_input, key) => {
			if (key.shift && key.upArrow) scrollBy(+1);
			else if (key.shift && key.downArrow) scrollBy(-1);
			else if (key.shift && key.pageUp) scrollBy(+5);
			else if (key.shift && key.pageDown) scrollBy(-5);
		},
		{ isActive: scrollEnabled },
	);

	// Mouse wheel. 2 messages per notch — fast enough to feel responsive,
	// small enough that a long bubble doesn't fly past in one click.
	useMouseScroll({
		enabled: scrollEnabled,
		step: 2,
		onWheelUp: () => scrollBy(+1),
		onWheelDown: () => scrollBy(-1),
	});

	// Auto-pin: new messages while pinned snap to bottom. If the user is
	// scrolled up, we BUMP scrollOffset so their view stays locked on the same
	// content (web behavior — adding new messages at the bottom must not shift
	// the messages the user is currently reading).
	useEffect(() => {
		if (total > prevCountRef.current) {
			const newMessage = chatMessages[chatMessages.length - 1];
			if (newMessage) setNewMessageId(newMessage.id);
			if (autoScrollRef.current) {
				setScrollOffset(0);
			} else {
				const delta = total - prevCountRef.current;
				setScrollOffset((prev) => Math.min(prev + delta, total - 1));
			}
		}
		prevCountRef.current = total;
	}, [total, chatMessages]);

	const { startIdx: sliceStart, sliceEnd } = computeWindow(clampedOffset);
	const visibleMessages = chatMessages.slice(sliceStart, sliceEnd);
	const _maxVisibleCap = maxVisible; // legacy prop retained for callers; not used in slicing.

	// Find the most recent assistant message — that's the only one that gets
	// the live teal accent. Older assistant replies render in muted to keep
	// the eye on the active response (no teal-everywhere wall).
	const lastAssistantId = (() => {
		for (let i = visibleMessages.length - 1; i >= 0; i--) {
			if (visibleMessages[i].role === "assistant") return visibleMessages[i].id;
		}
		return null;
	})();

	return (
		<Box flexDirection="column" flexGrow={1} minHeight={0}>
			{visibleMessages.length === 0 ? (
				<Box flexGrow={1} alignItems="center" justifyContent="center">
					<Text color={t.dim}>
						<Text color={t.orange}>8</Text>
						<Text color={t.textPrimary}>▣ </Text>
						<Text color={t.dim}>waiting with you</Text>
					</Text>
				</Box>
			) : null}
			{visibleMessages.map((message, index) => {
				// Animate only the first time we see this message. Once it's been
				// rendered as "new", subsequent renders (scroll back, slice churn)
				// treat it as static so TypingText doesn't replay.
				const isFirstShow =
					message.id === newMessageId && !animatedIdsRef.current.has(message.id);
				return (
					<MessageItem
						key={message.id}
						message={message}
						isNew={isFirstShow}
						animate={animateTyping}
						soundEnabled={soundEnabled}
						index={index}
						contentWidth={resolvedContentWidth}
						showAnimations={showAnimations}
						isLatestAssistant={message.id === lastAssistantId}
						onAnimationStart={(id) => {
							animatedIdsRef.current.add(id);
						}}
					/>
				);
			})}
			{clampedOffset > 0 && (
				<Box justifyContent="center" flexShrink={0}>
					<Text color={t.muted} dimColor>
						{`↓ ${clampedOffset} below — shift+↓ or scroll down to follow`}
					</Text>
				</Box>
			)}
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
	isLatestAssistant?: boolean;
	/** Fires once on first mount when isNew=true. Parent uses it to record
	 *  that this message has begun its typing animation, so future remounts
	 *  (from scroll) render the message statically. */
	onAnimationStart?: (id: string) => void;
}

function MessageItem({
	message,
	isNew,
	animate,
	soundEnabled,
	index,
	contentWidth,
	showAnimations,
	isLatestAssistant = false,
	onAnimationStart,
}: MessageItemProps) {
	// State value is read in render or feeds a derived value used in render — useRef would break visible output.
	// react-doctor-disable-next-line react-doctor/rerender-state-only-in-handlers
	const [showContent, setShowContent] = useState(!isNew);
	// State value is read in render or feeds a derived value used in render — useRef would break visible output.
	// react-doctor-disable-next-line react-doctor/rerender-state-only-in-handlers
	const [typingComplete, setTypingComplete] = useState(!isNew || !animate);

	// Messages occupy up to 78% of the content column, leaving a margin of
	// empty space on the opposite side so alignment reads clearly.
	// The outer Box reserves 2 cols for borderLeft (1) + paddingLeft (1),
	// so the actual content column is contentWidth-2. The bubble width and
	// wrap width each subtract 2 to preserve the existing overflow guarantees.
	const innerContentWidth = Math.max(16, contentWidth - 2);
	const maxBubbleWidth = Math.max(16, Math.floor(innerContentWidth * 0.78));
	// Text wraps strictly within that width. 2 chars slack keeps us safe from
	// edge-case character-width quirks.
	const textWrapWidth = Math.max(8, maxBubbleWidth - 2);

	// Play sound on completion for assistant messages
	useCompletionSound(typingComplete && message.role === "assistant" && isNew, soundEnabled);

	// Fade in the message header
	// react-doctor-disable-next-line react-doctor/no-effect-event-handler
	useEffect(() => {
		if (isNew) {
			onAnimationStart?.(message.id);
			const timeout = setTimeout(() => setShowContent(true), 50);
			return () => clearTimeout(timeout);
		}
	}, [isNew, message.id, onAnimationStart]);

	// Tool messages never render in chat (filtered at MessageList level). Guard anyway.
	if (message.role === "tool") return null;

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
			return fadeWrap(
				<Box flexDirection="column" marginBottom={1} paddingLeft={1}>
					<Text dimColor>{"─".repeat(3)}</Text>
					<SystemMessageText content={message.content} />
					<Text dimColor>{"─".repeat(3)}</Text>
				</Box>,
			);
		}
		// Single-line system message: keep the centered hint look when it fits
		// the column, otherwise fall back to the multi-line block so the full
		// text can soft-wrap. Onboarding clarification questions are too
		// important to truncate — show them in full even if they span 2 rows.
		const hintBudget = Math.max(20, contentWidth - 10);
		if (message.content.length <= hintBudget) {
			return fadeWrap(
				<Box justifyContent="center" marginBottom={1}>
					<Text dimColor>{"─".repeat(3)} </Text>
					<SystemMessageText content={message.content} />
					<Text dimColor> {"─".repeat(3)}</Text>
				</Box>,
			);
		}
		return fadeWrap(
			<Box flexDirection="column" marginBottom={1} paddingLeft={1}>
				<Text dimColor>{"─".repeat(3)}</Text>
				<Box width={contentWidth - 2}>
					<SystemMessageText content={message.content} />
				</Box>
				<Text dimColor>{"─".repeat(3)}</Text>
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

	// Pre-break long unbreakable tokens so Ink's wrap can't escape the column
	const safeContent = breakLongTokens(message.content, textWrapWidth);

	// Bar color: orange for user, teal for the latest assistant, muted for
	// older assistant turns (echoes the existing label-color contract).
	const barColor = isUser
		? t.orange
		: isLatestAssistant
			? t.teal
			: t.muted;

	// Footer renders only on assistant turns and only when the data exists.
	// Phase 2 will plumb latencyMs+tokens from the agent's onStepFinish event
	// onto the Message at completion. For now this is a no-op until the data
	// is present — keeps this PR purely visual.
	const showFooter =
		!isUser &&
		typeof message.latencyMs === "number" &&
		typeof message.tokens === "number";
	const footerLatency =
		message.latencyMs && message.latencyMs >= 1000
			? `${(message.latencyMs / 1000).toFixed(1)}s`
			: `${message.latencyMs ?? 0}ms`;
	const footerTokens =
		(message.tokens ?? 0) >= 1000
			? `${((message.tokens ?? 0) / 1000).toFixed((message.tokens ?? 0) >= 10000 ? 0 : 1)}k tok`
			: `${message.tokens ?? 0} tok`;

	const bubble = (
		<Box
			flexDirection="column"
			alignItems="flex-start"
			marginBottom={1}
			width={contentWidth}
			borderStyle="single"
			borderTop={false}
			borderRight={false}
			borderBottom={false}
			borderColor={barColor}
			paddingLeft={1}
		>
			{/* Sender label — the left-bar carries the visual frame */}
			<Box>
				{isUser ? (
					<>
						<MutedText>{formatTime(message.timestamp)} </MutedText>
						<Label color={t.orange}>You</Label>
					</>
				) : (
					<>
						<Label color={isLatestAssistant ? t.teal : t.muted}>{"\u25C6 8gent"}</Label>
						<MutedText> {formatTime(message.timestamp)}</MutedText>
					</>
				)}
			</Box>

			{/* Message body — left-bar carries the visual frame, strict width */}
			<Box width={maxBubbleWidth} flexShrink={1} flexDirection="column">
				<MessageContent
					content={safeContent}
					role={message.role}
					isNew={isNew}
					animate={animate}
					onTypingComplete={() => setTypingComplete(true)}
					wrapWidth={textWrapWidth}
					accentColor={isUser ? "yellow" : "cyan"}
				/>
			</Box>

			{/* Footer (assistant + metadata present): "Xs · N tok" */}
			{showFooter && (
				<Box>
					<MutedText>{`${footerLatency} · ${footerTokens}`}</MutedText>
				</Box>
			)}
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
	accentColor?: "yellow" | "cyan";
}

function MessageContent({
	content,
	role,
	isNew,
	animate,
	onTypingComplete,
	wrapWidth,
	accentColor,
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
				<TypingText text={content} speed={12} onComplete={onTypingComplete} cursor={true} />
			</Box>
		);
	}

	// Check for code blocks and format accordingly
	if (content.includes("```")) {
		return <FormattedContent content={content} adhdMode={adhdMode} wrapWidth={wrapWidth} />;
	}

	// Apply bionic reading if ADHD mode is enabled
	if (adhdMode) {
		return (
			<Box width={wrapWidth}>
				<BionicText>{content}</BionicText>
			</Box>
		);
	}

	// Tint text in the accent color so user vs assistant reads at a glance,
	// even without a border. Falls back to theme default when unset.
	return (
		<Box width={wrapWidth}>
			{accentColor ? (
				<Text color={accentColor} wrap="wrap">
					{content}
				</Text>
			) : (
				<AppText wrap="wrap">{content}</AppText>
			)}
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
			{/* parts come from a deterministic regex split of the message content into code-fence + prose segments; positional and never reordered for a given content string. */}
			{parts.map((part, index) => {
				if (part.startsWith("```")) {
					// Extract language and code
					const match = part.match(/```(\w+)?\n?([\s\S]*?)```/);
					if (match) {
						const [, language, code] = match;
						const fenceInner = Math.max(8, wrapWidth - 8);
						return (
							// react-doctor-disable-next-line react-doctor/no-array-index-as-key
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
								{language && <MutedText>{language}</MutedText>}
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
						// react-doctor-disable-next-line react-doctor/no-array-index-as-key
						<Box key={index} width={wrapWidth}>
							<BionicText>{part}</BionicText>
						</Box>
					);
				}
				return (
					// react-doctor-disable-next-line react-doctor/no-array-index-as-key
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
				<Label color="cyan">◆ 8gent</Label>
				{!isComplete && <Text color="cyan"> ▌</Text>}
			</Box>
			<Box paddingLeft={2}>
				<AppText wrap="wrap">{chunks.slice(0, displayedChunks).join("")}</AppText>
			</Box>
		</Stack>
	);
}
