/**
 * 8gent Code - Chat Interface
 *
 * Left-bar style, alignment-neutral (both roles left-aligned):
 * - User messages: orange left-bar, "You" label
 * - 8gent messages: teal left-bar (latest assistant) or muted (older), "8gent" label
 * - Footer (assistant only, when metadata present): "Xs · N tok" in muted
 * - Tool calls: one compact line each (✓ / ✗ / ⊘ + tool + short args), grouped
 *   into the assistant reply of their turn (components/ToolTrail.tsx). Calls
 *   with no reply yet show as a live trail. Raw tool output stays in the ^B
 *   processes panel; the live "Running <tool>" status is unchanged.
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
import { bubbleWidths, footerRidesSenderRow, replyFooter } from "../lib/chat-layout.js";
import { compactionRows } from "../lib/compaction-view.js";
import { type Notice, noticeLines } from "../lib/error-row.js";
import { blockedSentence, showsBlockedSentence, wrapSentence } from "../lib/folded-trace.js";
import {
	CODE_GUTTER,
	INDENT_STEP,
	type MarkdownOptions,
	type Span,
	blockRows,
	blockWrapWidth,
	hasMarkdown,
	layoutLines,
	markerWidth,
	parseBlocks,
	tableLines,
} from "../lib/inline-markdown.js";
import { type MarkStream, holdLivingMark } from "../lib/living-mark.js";
import { motionEnabled } from "../lib/motion.js";
import { wrapNotice } from "../lib/notice-wrap.js";
import { offsetAfterNewMessages, pageMessages, pagingAction } from "../lib/scroll-pin.js";
import { drawsColour, glyphs } from "../lib/term-caps.js";
import { useToolOutputVersion } from "../lib/tool-output-state.js";
import { type ChatItem, type ToolTrailEntry, buildChatItems } from "../lib/tool-trail.js";
import { bubblePlan, hasTurnResults, turnResultRows } from "../lib/turn-results.js";
import { t } from "../theme.js";
import { CompactionRow } from "./CompactionRow.js";
import { FoldedStatus } from "./FoldedStatus.js";
import { ToolTrail, toolTrailRows } from "./ToolTrail.js";
import { TurnResults } from "./TurnResults.js";
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
export const breakLongTokensForTest = (text: string, width: number): string =>
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
	/** True while the agent's turn is still running. A trail of calls with no
	 *  reply is live only while its turn runs; once the turn ends without a
	 *  reply, it settles into results like any finished turn. */
	turnRunning?: boolean;
	/** When false, skip bubble fade-in delays (matches ^A global anim toggle). */
	showAnimations?: boolean;
	/** Disable mouse-wheel + keyboard scroll capture (e.g. another modal owns input). */
	scrollEnabled?: boolean;
	/** A tap on a compaction row opens or folds its summary (#4958). */
	onToggleCompaction?: (messageId: string) => void;
	/**
	 * Keys-up layout (#4967): the scroll hints name PgUp and PgDn, keys a
	 * phone keyboard has, instead of shift+arrows, which it does not.
	 */
	touchHints?: boolean;
	/** An approval card is up: plain PgUp/PgDn page the card, not the chat. */
	approvalPending?: boolean;
	/** Bumped on every submit, slash commands included: the view returns to the live edge. */
	snapSeq?: number;
	/**
	 * Fold the running turn's steps behind one status row (#5170). False (the
	 * default) draws every step as a row, as before.
	 */
	foldTrace?: boolean;
	/** Folded, and the person has opened the step list in place. */
	traceOpen?: boolean;
	/** Enter or a tap on the status row. */
	onToggleTrace?: () => void;
	/** The call running now, for the status row's words. */
	liveTool?: string | null;
}

/** How the live trail is drawn: folded behind a status row, and whether it is open. */
export interface TraceFold {
	folded: boolean;
	open: boolean;
	/** This is the last item and no turn is running: the turn that just ended. */
	justEnded?: boolean;
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
/**
 * Rows a turn's calls take: the live trail while the turn runs (a "tool"
 * item), the results block once the reply has landed (an assistant item).
 */
function callRows(
	message: Message,
	trail: ToolTrailEntry[],
	maxRows?: number,
	width = 80,
	fold?: TraceFold,
): number {
	// Results carry one blank row between them and the reply (mockup A).
	if (message.role === "assistant") {
		const plan = bubblePlan(message.content, message.plan, trail);
		return hasTurnResults(trail, plan) ? turnResultRows(trail, maxRows, plan, width) + 1 : 0;
	}
	if (trail.length === 0) return 0;
	if (fold?.folded) {
		// The status row, and under it the full list while it is open.
		if (!fold.open) return 1;
		return (
			1 + toolTrailRows(trail, maxRows === undefined ? undefined : Math.max(1, maxRows - 1), width)
		);
	}
	return toolTrailRows(trail, maxRows, width);
}

/** The sentence under a turn's results when a blocked step ended it (folded mode only). */
function blockedLines(
	message: Message,
	trail: ToolTrailEntry[],
	width: number,
	fold?: TraceFold,
): string[] {
	if (!fold?.folded) return [];
	// Only the turn that just ended, and only when the block is why it ended.
	if (!showsBlockedSentence({ justEnded: fold.justEnded === true, reply: message.content }))
		return [];
	const sentence = blockedSentence(trail);
	return sentence ? wrapSentence(sentence, width) : [];
}

function estimateMessageRows(
	message: Message,
	wrapWidth: number,
	trail: ToolTrailEntry[] = [],
	fold?: TraceFold,
): number {
	if (message.notice)
		return (
			noticeLines(message.notice, wrapWidth).length + (message.notice.tone === "error" ? 1 : 0)
		);
	const trailRows = callRows(message, trail, undefined, wrapWidth, fold);
	// A standalone trail (calls with no reply yet): its rows + marginBottom.
	if (message.role === "tool") return trailRows > 0 ? trailRows + 1 : 0;
	const w = Math.max(1, wrapWidth);
	if (message.compaction) return compactionRows(message.compaction, w);
	if (message.role === "system") {
		if (!message.content.includes("\n") && message.content.length > Math.max(20, wrapWidth - 10)) {
			return wrapNotice(message.content, w - 2).length + (wrapWidth >= 60 ? 2 : 0) + 1;
		}
		const safe = breakLongTokens(message.content, w);
		let rows = 0;
		for (const line of safe.split("\n")) {
			rows += Math.max(1, Math.ceil(line.length / w));
		}
		// Multi-line system messages get top/bottom ─── separators (2 extra rows).
		return rows + (message.content.includes("\n") ? 2 : 0) + 1;
	}
	// The body as MarkdownBody draws it: same blocks, same widths.
	const rows = message.content.trim() || trail.length === 0 ? bodyRows(message.content, w) : 1;
	// 1 header + 1 marginBottom; assistant with metadata = 1 footer too.
	const hasFooter =
		message.role === "assistant" &&
		typeof message.latencyMs === "number" &&
		typeof message.tokens === "number";
	const overhead =
		hasFooter && !footerRidesSenderRow(w, replyFooter(message.latencyMs ?? 0, message.tokens ?? 0))
			? 3
			: 2;
	const blocked =
		message.role === "assistant"
			? blockedLines(message, trail, Math.max(1, wrapWidth), fold).length
			: 0;
	return rows + overhead + trailRows + blocked;
}

/** The row estimate, exposed so tests can hold it to what Ink draws. */
export const estimateMessageRowsForTest = (
	message: Message,
	wrapWidth: number,
	trail: ToolTrailEntry[] = [],
	fold?: TraceFold,
): number => estimateMessageRows(message, wrapWidth, trail, fold);

/** Rows a message body draws at wrap width `w`, laid out as MarkdownBody draws it. */
function bodyRows(content: string, w: number): number {
	const blocks = parseBlocks(content, markdownOptions());
	if (blocks.length === 0) return 1;
	let rows = 0;
	for (const block of blocks) rows += blockRows(block, w);
	return rows;
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
	turnRunning = true,
	onToggleCompaction,
	touchHints = false,
	approvalPending = false,
	snapSeq = 0,
	foldTrace = false,
	traceOpen = false,
	onToggleTrace,
	liveTool = null,
}: MessageListProps) {
	const { stdout } = useStdout();
	// Opening or closing a tool output changes row heights: re-estimate.
	useToolOutputVersion();
	const resolvedContentWidth = contentWidthProp ?? Math.max(24, (stdout?.columns ?? 80) - 8);
	// Width used to estimate wrapped line count: the same per-role math
	// MessageItem uses for its body (bubbleWidths), so estimate and render agree.
	// Default rowBudget: tall enough that small chats render fully, low enough
	// that long sessions still clip on a typical terminal (80x24).
	const resolvedRowBudget = Math.max(4, rowBudget ?? Math.max(8, (stdout?.rows ?? 24) - 10));

	const prevCountRef = useRef(messages.length);
	const [newMessageId, setNewMessageId] = useState<string | null>(null);
	// Messages we've already kicked off the typing animation for. Once an ID
	// lands here, future remounts (caused by scrolling out of the slice and
	// back) render statically — pages stay stable like a book.
	const animatedIdsRef = useRef<Set<string>>(new Set());

	// Raw tool messages never render in chat. Each finished call's trail entry
	// attaches to its turn's assistant reply; calls with no reply yet become a
	// standalone trail item.
	// A turn that ended with calls but no reply text still gets its results:
	// its trail item becomes a reply-less 8gent turn ("No reply." below the
	// results). Only the newest trail, while its turn runs, stays live.
	const grouped: ChatItem<Message>[] = buildChatItems(messages);
	const chatItems: ChatItem<Message>[] = grouped.map((it, idx) =>
		it.message.role === "tool" && !(turnRunning && idx === grouped.length - 1)
			? { ...it, message: { ...it.message, role: "assistant" as const, content: "" } }
			: it,
	);
	const chatMessages = chatItems.map((i) => i.message);
	const trailById = new Map(chatItems.map((i) => [i.message.id, i.trail]));

	// Folded mode (#5170): the live trail is one status row; every finished turn
	// keeps its results, and a turn a blocked step ended gets one plain sentence.
	const lastItemId = chatItems[chatItems.length - 1]?.message.id;
	const foldFor = (m: Message): TraceFold | undefined =>
		foldTrace
			? {
					folded: true,
					open: traceOpen && m.role === "tool",
					justEnded: !turnRunning && m.id === lastItemId,
				}
			: undefined;
	// The turn began at the newest message from the person.
	const turnStartedAt = (() => {
		for (let i = messages.length - 1; i >= 0; i--) {
			if (messages[i].role === "user") return messages[i].timestamp.getTime();
		}
		return Date.now();
	})();

	// Per-message estimated row counts. Cheap to compute; no memo needed.
	// A turn whose trail would push it past the whole window gets its trail
	// capped (oldest calls fold into one summary row): an item taller than
	// the container is what makes Ink leave stale characters behind.
	const trailCaps = new Map<string, number>();
	const rowEstimates = chatItems.map((i) => {
		const wrap = bubbleWidths(resolvedContentWidth, i.message.role).wrap;
		const fold = foldFor(i.message);
		const full = estimateMessageRows(i.message, wrap, i.trail, fold);
		const trailRows = callRows(i.message, i.trail, undefined, wrap, fold);
		if (trailRows === 0 || full <= resolvedRowBudget) return full;
		const base = full - trailRows;
		// The results' gap row is not a trail row: leave it out of the cap.
		const gap = i.message.role === "assistant" ? 1 : 0;
		const cap = Math.max(1, resolvedRowBudget - base - gap);
		trailCaps.set(i.message.id, cap);
		return base + callRows(i.message, i.trail, cap, wrap, fold);
	});

	// --- Scroll state (web-style auto-pin + content-anchored offset) ---
	// scrollOffset = messages held back from the bottom. autoScrollRef tracks
	// whether the user is pinned to the live edge.
	const [scrollOffset, setScrollOffset] = useState(0);
	const scrollOffsetRef = useRef(0);
	scrollOffsetRef.current = scrollOffset;
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

	// A scrolled chat is being read: the header's braille 8 holds still.
	const scrolled = clampedOffset > 0;
	useEffect(() => {
		if (!stdout) return;
		holdLivingMark("scroll", scrolled, stdout as unknown as MarkStream);
		return () => holdLivingMark("scroll", false, stdout as unknown as MarkStream);
	}, [scrolled, stdout]);

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
			const action = pagingAction(key, { approvalPending: Boolean(approvalPending) });
			if (!action) return;
			if ("step" in action) scrollBy(action.step);
			else
				scrollBy(
					pageMessages({
						rows: rowEstimates,
						offset: scrollOffsetRef.current,
						dir: action.page,
						pageRows: Math.max(1, resolvedRowBudget - 2),
					}),
				);
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

	// A submit of any kind (a slash command adds no user message) returns to the live edge.
	const lastSnapRef = useRef(snapSeq);
	useEffect(() => {
		if (snapSeq === lastSnapRef.current) return;
		lastSnapRef.current = snapSeq;
		autoScrollRef.current = true;
		setScrollOffset(0);
	}, [snapSeq]);

	// Auto-pin: new messages while pinned snap to bottom. If the user is
	// scrolled up, we BUMP scrollOffset so their view stays locked on the same
	// content (web behavior — adding new messages at the bottom must not shift
	// the messages the user is currently reading).
	useEffect(() => {
		if (total > prevCountRef.current) {
			const newMessage = chatMessages[chatMessages.length - 1];
			if (newMessage) setNewMessageId(newMessage.id);
			const next = offsetAfterNewMessages({
				offset: scrollOffsetRef.current,
				pinned: autoScrollRef.current,
				added: chatMessages.slice(prevCountRef.current),
				total,
			});
			autoScrollRef.current = next.pinned;
			setScrollOffset(next.offset);
		}
		prevCountRef.current = total;
	}, [total, chatMessages]);

	const { startIdx: sliceStart, sliceEnd } = computeWindow(clampedOffset);
	const visibleMessages = chatMessages.slice(sliceStart, sliceEnd);
	// A window taller than the box (one message longer than the whole chat
	// area, or estimates that undercount) is anchored to its bottom so the
	// newest lines stay on screen and the oldest clip off the top (#3019).
	let windowRows = 0;
	for (let i = sliceStart; i < sliceEnd; i++) windowRows += rowEstimates[i] ?? 0;
	const anchorBottom = windowRows > resolvedRowBudget;
	// When the top is clipped, say so on a row of its own, outside the clip
	// box, so the reader knows the reply did not start where the box does.
	// The marker costs one row, so it is counted in what is hidden.
	const hiddenAbove = anchorBottom ? windowRows - (resolvedRowBudget - 1) : 0;
	const canScrollUp = clampedOffset < maxScrollOffset;
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
			{hiddenAbove > 0 && (
				<Box flexShrink={0}>
					<Text color={t.muted} dimColor>
						{touchHints
							? `↑ ${hiddenAbove} earlier${canScrollUp ? "  [PgUp]" : ""}`
							: `↑ ${hiddenAbove} earlier ${hiddenAbove === 1 ? "line" : "lines"}${canScrollUp ? "  PgUp" : ""}`}
					</Text>
				</Box>
			)}
			<Box
				flexDirection="column"
				flexGrow={1}
				minHeight={0}
				overflow="hidden"
				justifyContent={anchorBottom ? "flex-end" : "flex-start"}
			>
				{visibleMessages.length === 0 ? (
					<Box flexGrow={1} alignItems="center" justifyContent="center">
						<Text color={t.textTertiary}>
							<Text color={t.orange}>8</Text>
							<Text color={t.textPrimary}>▣ </Text>
							<Text color={t.textTertiary}>waiting with you</Text>
						</Text>
					</Box>
				) : null}
				{visibleMessages.map((message, index) => {
					// Animate only the first time we see this message. Once it's been
					// rendered as "new", subsequent renders (scroll back, slice churn)
					// treat it as static so TypingText doesn't replay.
					const isFirstShow =
						message.id === newMessageId && !animatedIdsRef.current.has(message.id);
					// flexShrink 0: Ink squeezes a shrinkable item to fit, and a
					// squeezed text block draws its lines on top of each other.
					// Rows that do not fit are clipped by the list box instead.
					return (
						<Box key={message.id} flexDirection="column" flexShrink={0}>
							<MessageItem
								message={message}
								isNew={isFirstShow}
								animate={animateTyping}
								soundEnabled={soundEnabled}
								index={index}
								contentWidth={resolvedContentWidth}
								showAnimations={showAnimations}
								isLatestAssistant={message.id === lastAssistantId}
								trail={trailById.get(message.id) ?? []}
								turnRunning={turnRunning}
								trailMaxRows={trailCaps.get(message.id)}
								fold={foldFor(message)}
								liveTool={liveTool}
								turnStartedAt={turnStartedAt}
								onToggleTrace={onToggleTrace}
								onToggleCompaction={onToggleCompaction}
								onAnimationStart={(id) => {
									animatedIdsRef.current.add(id);
								}}
							/>
						</Box>
					);
				})}
			</Box>
			{clampedOffset > 0 && (
				<Box justifyContent="center" flexShrink={0}>
					<Text color={t.muted} dimColor>
						{touchHints
							? `↓ ${clampedOffset} below  [PgDn]`
							: `↓ ${clampedOffset} below  PgDn to follow`}
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
	/** Tool calls of this turn (assistant), or of a turn with no reply yet (tool). */
	trail?: ToolTrailEntry[];
	/** A turn is still running: a reply-less trail is not yet a turn with no reply. */
	turnRunning?: boolean;
	/** Row ceiling for the trail when the turn would not fit the window. */
	trailMaxRows?: number;
	/** A tap on a compaction row (#4958). */
	onToggleCompaction?: (messageId: string) => void;
	/** Folded trace (#5170): how the live trail and a blocked finish are drawn. */
	fold?: TraceFold;
	liveTool?: string | null;
	turnStartedAt?: number;
	onToggleTrace?: () => void;
	/** Fires once on first mount when isNew=true. Parent uses it to record
	 *  that this message has begun its typing animation, so future remounts
	 *  (from scroll) render the message statically. */
	onAnimationStart?: (id: string) => void;
}

/** An error row (red, with its lines) or a one-line guard or retry notice (orange). */
function NoticeView({ notice, width }: { notice: Notice; width: number }) {
	const lines = noticeLines(notice, width);
	const g = glyphs();
	return (
		<Box
			flexDirection="column"
			flexShrink={0}
			marginBottom={notice.tone === "error" ? 1 : 0}
			width={width}
		>
			{lines.map((line, i) => {
				const text = line.startsWith("✗") ? `${g.fail}${line.slice(1)}` : line;
				const color = notice.tone === "error" ? (i === 0 ? t.red : t.muted) : t.orange;
				return (
					// Lines are positional within one notice and never reorder.
					// react-doctor-disable-next-line react-doctor/no-array-index-as-key
					<Box key={i} width={width} height={1}>
						<Text color={color} wrap="truncate-end">
							{text}
						</Text>
					</Box>
				);
			})}
		</Box>
	);
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
	trail = [],
	turnRunning = false,
	trailMaxRows,
	fold,
	liveTool = null,
	turnStartedAt = 0,
	onToggleTrace,
	onToggleCompaction,
	onAnimationStart,
}: MessageItemProps) {
	// State value is read in render or feeds a derived value used in render — useRef would break visible output.
	// react-doctor-disable-next-line react-doctor/rerender-state-only-in-handlers
	const [showContent, setShowContent] = useState(!isNew);
	// State value is read in render or feeds a derived value used in render — useRef would break visible output.
	// react-doctor-disable-next-line react-doctor/rerender-state-only-in-handlers
	const [typingComplete, setTypingComplete] = useState(!isNew || !animate);

	// A user message takes 78% of the column so the two voices read as a
	// conversation; the assistant's reply takes the full column (chat first).
	// The outer Box reserves 2 cols for borderLeft (1) + paddingLeft (1), so
	// the content column is contentWidth-2. Text wraps 2 cols inside the
	// bubble to stay safe from edge-case character-width quirks.
	const innerContentWidth = Math.max(16, contentWidth - 2);
	const { bubble: maxBubbleWidth, wrap: textWrapWidth } = bubbleWidths(contentWidth, message.role);

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

	// An error, a retry or a loop guard is its own row, in turn order, never a bubble or a grey card.
	if (message.notice) {
		return <NoticeView notice={message.notice} width={innerContentWidth} />;
	}

	// A "tool" item here is a standalone trail: calls with no reply yet. Raw
	// tool messages are dropped by buildChatItems and never reach this point.
	if (message.role === "tool") {
		if (trail.length === 0) return null;
		return (
			<Box
				flexDirection="column"
				marginBottom={1}
				width={contentWidth}
				borderStyle="single"
				borderTop={false}
				borderRight={false}
				borderBottom={false}
				borderColor={t.muted}
				paddingLeft={1}
			>
				{fold?.folded ? (
					<FoldedStatus
						trail={trail}
						liveTool={liveTool}
						startedAt={turnStartedAt}
						open={fold.open}
						width={innerContentWidth}
						onToggle={onToggleTrace}
					/>
				) : null}
				{!fold?.folded || fold.open ? (
					<ToolTrail
						entries={trail}
						width={innerContentWidth}
						maxRows={
							fold?.folded && trailMaxRows !== undefined
								? Math.max(1, trailMaxRows - 1)
								: trailMaxRows
						}
						animate={showAnimations}
					/>
				) : null}
			</Box>
		);
	}

	// A compaction renders as its own row, open or folded (#4958).
	if (message.compaction) {
		return (
			<CompactionRow
				id={message.id}
				note={message.compaction}
				width={textWrapWidth}
				onToggle={onToggleCompaction}
			/>
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
		// Under 60 columns a wrapped one-line notice drops its two rule rows: the
		// dim text with no bubble header already reads as a notice, and every
		// row counts when a notice stack scrolls the chat away.
		const ruled = contentWidth >= 60;
		return fadeWrap(
			<Box flexDirection="column" marginBottom={1} paddingLeft={1}>
				{ruled ? <Text dimColor>{"─".repeat(3)}</Text> : null}
				<Box width={contentWidth - 2} flexDirection="column">
					{wrapNotice(message.content, contentWidth - 2).map((row, i) => (
						<SystemMessageText key={i} content={row} />
					))}
				</Box>
				{ruled ? <Text dimColor>{"─".repeat(3)}</Text> : null}
			</Box>,
		);
	}

	const isUser = message.role === "user";
	const shownPlan = isUser ? undefined : bubblePlan(message.content, message.plan, trail);

	if (!showContent) {
		return (
			<Box marginBottom={1} justifyContent={isUser ? "flex-end" : "flex-start"}>
				<MutedText>...</MutedText>
			</Box>
		);
	}

	// Bar color: steel for the user, teal for the latest assistant, muted for
	// older assistant turns. Orange is kept for state and focus (the active
	// tab, DONE, the input, the selection), so the user's voice is not it.
	const barColor = isUser ? t.steel : isLatestAssistant ? t.teal : t.muted;

	// Footer renders only on assistant turns and only when the data exists.
	// Phase 2 will plumb latencyMs+tokens from the agent's onStepFinish event
	// onto the Message at completion. For now this is a no-op until the data
	// is present — keeps this PR purely visual.
	const showFooter =
		!isUser && typeof message.latencyMs === "number" && typeof message.tokens === "number";
	const footerText = replyFooter(message.latencyMs ?? 0, message.tokens ?? 0);
	const footerOnSenderRow = showFooter && footerRidesSenderRow(textWrapWidth, footerText);

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
						<Label color={t.steel}>You</Label>
					</>
				) : (
					<>
						<Label color={isLatestAssistant ? t.teal : t.muted}>{"\u25C6 8gent"}</Label>
						<MutedText> {formatTime(message.timestamp)}</MutedText>
						{footerOnSenderRow && <MutedText>{` · ${footerText}`}</MutedText>}
					</>
				)}
			</Box>

			{/* The finished turn's work as checked steps, above the reply text.
			    While the turn ran, the same calls showed as the live trail.
			    A turn that only wrote a plan shows the plan (#3096), unless the
			    reply already lists it with nothing ticked (#3123). */}
			{!isUser && hasTurnResults(trail, shownPlan) && (
				<Box flexDirection="column" flexShrink={0} marginBottom={message.content.trim() ? 1 : 0}>
					<TurnResults
						trail={trail}
						plan={shownPlan}
						width={innerContentWidth}
						maxRows={trailMaxRows}
						land={isNew}
						animate={showAnimations}
					/>
				</Box>
			)}

			{/* A blocked or refused step ended the turn: one plain sentence, never the raw reason (#5170). */}
			{!isUser
				? blockedLines(message, trail, textWrapWidth, fold).map((line, i) => (
						// Lines are positional within one sentence.
						// react-doctor-disable-next-line react-doctor/no-array-index-as-key
						<Text key={i} color={t.orange}>
							{line}
						</Text>
					))
				: null}

			{/* A turn that ended with calls and no words says so, quietly. Never while a
			    turn still runs: a queued follow-up lands after the trail, which settles it
			    to a reply-less item although its turn is mid-flight (#4756). */}
			{!isUser && !turnRunning && !message.content.trim() && trail.length > 0 ? (
				<MutedText>No reply.</MutedText>
			) : null}

			{/* Message body — left-bar carries the visual frame, strict width */}
			{message.content.trim() || trail.length === 0 ? (
				<Box width={maxBubbleWidth} flexShrink={1} flexDirection="column">
					<MessageContent
						content={message.content}
						role={message.role}
						isNew={isNew}
						animate={animate}
						onTypingComplete={() => setTypingComplete(true)}
						wrapWidth={textWrapWidth}
						color={isUser ? t.textSecondary : t.prose}
					/>
				</Box>
			) : null}

			{/* Footer (assistant + metadata present): "Xs · N tok" */}
			{showFooter && !footerOnSenderRow && (
				<Box>
					<MutedText>{footerText}</MutedText>
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
	/** Body text colour; a theme token. */
	color: string;
}

function MessageContent({
	content,
	role,
	isNew,
	animate,
	onTypingComplete,
	wrapWidth,
	color,
}: MessageContentProps) {
	const { enabled: adhdMode } = useADHDMode();

	// The typewriter runs only for plain prose. Over markdown it would type
	// the raw ** and backticks and then jump to the drawn form; a reply with
	// markup lands drawn, at once. Reduced motion skips it too.
	const shouldAnimate =
		isNew && motionEnabled(animate) && role === "assistant" && !hasMarkdown(content);

	// The typewriter never runs for this reply; report it done so the
	// completion sound still plays once.
	// react-doctor-disable-next-line react-doctor/no-effect-event-handler
	useEffect(() => {
		if (!shouldAnimate) onTypingComplete();
		// Once, on mount: the reply either typed or it did not.
	}, []);

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

	return <MarkdownBody content={content} wrapWidth={wrapWidth} color={color} adhdMode={adhdMode} />;
}

/** Parse options for this terminal: chips need colour, bullets need Unicode. */
function markdownOptions(): MarkdownOptions {
	return { chips: drawsColour(), bullet: glyphs().bullet };
}

/**
 * A reply drawn from lib/inline-markdown: inline code as a quiet chip (the
 * same tint as the DONE results' path chips), bold as bold, lists with a
 * hanging indent, and fences as a plain block behind a thin rule. The row
 * estimator counts the same blocks at the same widths (markdownRows).
 */
function MarkdownBody({
	content,
	wrapWidth,
	color,
	adhdMode = false,
}: {
	content: string;
	wrapWidth: number;
	color: string;
	adhdMode?: boolean;
}) {
	const blocks = parseBlocks(content, markdownOptions());
	const g = glyphs();
	return (
		<Box flexDirection="column" width={wrapWidth}>
			{/* blocks come from a deterministic parse of the content; positional and never reordered. */}
			{blocks.map((block, index) => {
				const key = `${block.kind}-${index}`;
				if (block.kind === "blank") return <Text key={key}> </Text>;
				if (block.kind === "table") {
					return (
						<Box key={key} flexDirection="column" width={wrapWidth}>
							{tableLines(block, wrapWidth).map((l, li) => (
								// react-doctor-disable-next-line react-doctor/no-array-index-as-key
								<Text
									key={li}
									bold={l.tone === "head"}
									color={l.tone === "body" || l.tone === "head" ? t.textPrimary : t.textTertiary}
								>
									{l.text || " "}
								</Text>
							))}
						</Box>
					);
				}
				if (block.kind === "code") {
					const w = blockWrapWidth(block, wrapWidth);
					return (
						<Box key={key} flexDirection="column" width={wrapWidth}>
							{block.lang ? <Text color={t.textTertiary}>{block.lang}</Text> : null}
							{block.lines.map((line, li) => (
								// react-doctor-disable-next-line react-doctor/no-array-index-as-key
								<Box key={li} width={wrapWidth}>
									<Box width={CODE_GUTTER} flexShrink={0}>
										<Text color={t.textTertiary}>{g.gutter}</Text>
									</Box>
									<Box width={w}>
										<Text color={t.textPrimary} wrap="wrap">
											{line || " "}
										</Text>
									</Box>
								</Box>
							))}
						</Box>
					);
				}
				const w = blockWrapWidth(block, wrapWidth);
				const text = (
					<Box flexDirection="column" width={w}>
						{layoutLines(block.spans, w, block.kind === "para" && block.keepSpaces).map(
							(line, li) => (
								// react-doctor-disable-next-line react-doctor/no-array-index-as-key
								<InlineSpans key={li} spans={line} color={color} adhdMode={adhdMode} />
							),
						)}
					</Box>
				);
				if (block.kind === "item") {
					const indent = block.depth * INDENT_STEP;
					return (
						<Box key={key} width={wrapWidth} paddingLeft={indent}>
							<Box width={markerWidth(block.marker)} flexShrink={0}>
								<Text color={t.textTertiary}>{block.marker}</Text>
							</Box>
							{text}
						</Box>
					);
				}
				return (
					<Box key={key} width={wrapWidth}>
						{text}
					</Box>
				);
			})}
		</Box>
	);
}

function InlineSpans({
	spans,
	color,
	adhdMode,
}: { spans: Span[]; color: string; adhdMode: boolean }) {
	return (
		<Text color={color} wrap="wrap">
			{spans.length === 0 ? " " : null}
			{/* spans are positional output of layoutLines; never reordered. */}
			{spans.map((s, i) => {
				if (s.code) {
					return (
						// react-doctor-disable-next-line react-doctor/no-array-index-as-key
						<Text key={i} backgroundColor={t.border} color={t.textPrimary} bold={s.bold}>
							{s.text}
						</Text>
					);
				}
				if (adhdMode && !s.bold) {
					// react-doctor-disable-next-line react-doctor/no-array-index-as-key
					return <BionicText key={i}>{s.text}</BionicText>;
				}
				return (
					// react-doctor-disable-next-line react-doctor/no-array-index-as-key
					<Text key={i} bold={s.bold} italic={s.italic}>
						{s.text}
					</Text>
				);
			})}
		</Text>
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

	const roleColors: Record<string, string> = {
		user: "yellow",
		assistant: "cyan",
		system: "cyan",
		tool: t.teal,
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
