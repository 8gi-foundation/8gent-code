/**
 * 8gent Code - Conversation Summarizer
 *
 * Zero-dependency progressive summarization of agent conversation histories.
 * Extracts decisions, action items, and topics from message arrays.
 *
 * No external deps. No AI calls. Pure text analysis.
 */

import type { Message, MessageContent } from "./types.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Decision {
  /** The decision that was made */
  statement: string;
  /** Turn index (0-based) where the decision appeared */
  turnIndex: number;
  /** "user" | "assistant" - who stated the decision */
  speaker: "user" | "assistant";
}

export interface ActionItem {
  /** The action to be taken */
  action: string;
  /** Optional owner extracted from text ("I will", "you should", etc.) */
  owner: "user" | "assistant" | "unspecified";
  /** Turn index where it appeared */
  turnIndex: number;
  /** Whether it appears to be completed based on later messages */
  completed: boolean;
}

export interface TopicSegment {
  /** Short label for the topic */
  label: string;
  /** Turn index where this topic began */
  startTurn: number;
  /** Turn index where this topic ended (inclusive) */
  endTurn: number;
  /** Key phrases associated with this topic */
  keyPhrases: string[];
}

export interface ConversationSummary {
  /** One-paragraph overview of the whole conversation */
  overview: string;
  /** Number of messages processed */
  messageCount: number;
  /** Detected topic segments in order */
  topics: TopicSegment[];
  /** Decisions extracted from the conversation */
  decisions: Decision[];
  /** Action items extracted */
  actionItems: ActionItem[];
  /** Key phrases that appeared frequently */
  topPhrases: string[];
  /** Progressive summaries - one per chunk if conversation is long */
  progressiveSummaries: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract plain text from a MessageContent value */
function toText(content: MessageContent): string {
  if (typeof content === "string") return content;
  return content
    .filter((p) => p.type === "text" && p.text)
    .map((p) => p.text!)
    .join(" ");
}

/** Normalize whitespace */
function normalize(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Sentence tokenizer - splits on . ? ! preserving abbreviations roughly */
function sentences(text: string): string[] {
  return text
    .split(/(?<=[.?!])\s+(?=[A-Z"'])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 10);
}

/** Naive word tokenizer, lowercased, no punctuation */
function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2);
}

/** Stop words to exclude from phrase extraction */
const STOP_WORDS = new Set([
  "the", "and", "that", "this", "with", "for", "are", "was", "you",
  "have", "from", "not", "but", "can", "will", "all", "been", "has",
  "had", "were", "they", "their", "which", "when", "what", "how",
  "its", "also", "use", "get", "let", "run", "see", "now", "just",
  "any", "our", "your", "more", "need", "want", "would", "should",
  "could", "than", "then", "into", "out", "there", "here", "some",
  "one", "two", "new", "add", "set", "via", "per",
]);

/** Extract bigrams and unigrams as phrase candidates */
function extractPhrases(text: string): string[] {
  const ws = words(text).filter((w) => !STOP_WORDS.has(w));
  const phrases: string[] = [...ws];
  for (let i = 0; i < ws.length - 1; i++) {
    phrases.push(`${ws[i]} ${ws[i + 1]}`);
  }
  return phrases;
}

/** Count phrase frequency across a list of strings */
function phraseFrequency(texts: string[]): Map<string, number> {
  const freq = new Map<string, number>();
  for (const text of texts) {
    for (const phrase of extractPhrases(text)) {
      freq.set(phrase, (freq.get(phrase) ?? 0) + 1);
    }
  }
  return freq;
}

/** Top N entries by frequency */
function topN<T>(map: Map<T, number>, n: number): T[] {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k]) => k);
}

// ---------------------------------------------------------------------------
// Decision detection
// ---------------------------------------------------------------------------

const DECISION_PATTERNS: Array<{ re: RegExp; weight: number }> = [
  { re: /\bwe('ll| will| are going to| decided to| agreed to)\b/i, weight: 3 },
  { re: /\blet'?s\b.{0,60}(use|go with|pick|choose|adopt|keep|drop|switch)/i, weight: 3 },
  { re: /\b(decision|decided|agreed|conclusion|settled on|going with|chosen)\b/i, weight: 2 },
  { re: /\b(final(ly)?|resolved|approved)\b/i, weight: 1 },
];

function scoreDecision(sentence: string): number {
  return DECISION_PATTERNS.reduce(
    (sum, { re, weight }) => sum + (re.test(sentence) ? weight : 0),
    0
  );
}

function detectDecisions(messages: Message[]): Decision[] {
  const results: Decision[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === "system" || msg.role === "tool") continue;
    const text = toText(msg.content);
    for (const sentence of sentences(text)) {
      if (scoreDecision(sentence) >= 2) {
        results.push({
          statement: normalize(sentence),
          turnIndex: i,
          speaker: msg.role === "user" ? "user" : "assistant",
        });
      }
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Action item detection
// ---------------------------------------------------------------------------

const ACTION_PATTERNS: Array<{ re: RegExp; owner: ActionItem["owner"] }> = [
  { re: /\bI('ll| will| am going to| need to| should| must)\b/i, owner: "assistant" },
  { re: /\byou (should|need to|must|can|could|please)\b/i, owner: "user" },
  { re: /\b(todo|to-do|action item|next step|follow.?up)\b/i, owner: "unspecified" },
  {
    re: /\b(implement|create|build|fix|update|add|remove|deploy|ship|write|test|review|check|verify)\b.{0,80}(it|this|that|the)\b/i,
    owner: "unspecified",
  },
  { re: /^\s*[-*]\s+.{10,}/m, owner: "unspecified" },
];

const COMPLETION_PATTERNS = [
  /\b(done|completed|finished|implemented|fixed|shipped|deployed|merged|closed|resolved)\b/i,
  /\b(already|have been|was|were)\b.{0,30}(done|added|built|fixed|updated|implemented)\b/i,
];

function detectActionItems(messages: Message[]): ActionItem[] {
  const candidates: ActionItem[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === "system" || msg.role === "tool") continue;
    const text = toText(msg.content);

    for (const sentence of sentences(text)) {
      for (const { re, owner } of ACTION_PATTERNS) {
        if (re.test(sentence)) {
          const existing = candidates.find(
            (c) => similarity(c.action, sentence) > 0.6
          );
          if (!existing) {
            candidates.push({
              action: normalize(sentence),
              owner:
                msg.role === "user" && owner === "assistant"
                  ? "user"
                  : msg.role === "assistant" && owner === "user"
                  ? "assistant"
                  : owner,
              turnIndex: i,
              completed: false,
            });
          }
          break;
        }
      }
    }
  }

  // Mark completed: scan later messages for completion signals referencing similar text
  const laterText = messages
    .map((m, i) => ({ text: toText(m.content), i }))
    .filter(({ text }) => COMPLETION_PATTERNS.some((re) => re.test(text)));

  for (const item of candidates) {
    for (const { text, i } of laterText) {
      if (i > item.turnIndex) {
        const itemWords = words(item.action).filter((w) => !STOP_WORDS.has(w));
        const matchCount = itemWords.filter((w) => text.toLowerCase().includes(w)).length;
        if (itemWords.length > 0 && matchCount / itemWords.length > 0.4) {
          item.completed = true;
          break;
        }
      }
    }
  }

  return candidates;
}

/** Rough word-overlap similarity, 0-1 */
function similarity(a: string, b: string): number {
  const wa = new Set(words(a).filter((w) => !STOP_WORDS.has(w)));
  const wb = new Set(words(b).filter((w) => !STOP_WORDS.has(w)));
  if (wa.size === 0 || wb.size === 0) return 0;
  let overlap = 0;
  for (const w of wa) if (wb.has(w)) overlap++;
  return overlap / Math.max(wa.size, wb.size);
}

// ---------------------------------------------------------------------------
// Topic segmentation
// ---------------------------------------------------------------------------

/**
 * Sliding-window topic segmentation.
 * Groups consecutive messages that share high phrase overlap.
 */
function segmentTopics(messages: Message[], windowSize = 4): TopicSegment[] {
  if (messages.length === 0) return [];

  const nonSystem = messages.filter((m) => m.role !== "system" && m.role !== "tool");
  if (nonSystem.length === 0) return [];

  const msgPhrases = nonSystem.map((m) => {
    const ws = words(toText(m.content)).filter((w) => !STOP_WORDS.has(w));
    return new Set(ws);
  });

  const segments: TopicSegment[] = [];
  let segStart = 0;
  let prevWindow = new Set<string>();

  for (let i = 0; i < nonSystem.length; i++) {
    const windowEnd = Math.min(i + windowSize, nonSystem.length);
    const currentWindow = new Set<string>();
    for (let j = i; j < windowEnd; j++) {
      for (const p of msgPhrases[j]) currentWindow.add(p);
    }

    if (prevWindow.size > 0) {
      let overlap = 0;
      for (const p of currentWindow) if (prevWindow.has(p)) overlap++;
      const overlapRatio = overlap / Math.max(prevWindow.size, currentWindow.size);

      if (overlapRatio < 0.15 && i > segStart) {
        const segMessages = nonSystem.slice(segStart, i);
        segments.push(buildSegment(segMessages, segStart, i - 1));
        segStart = i;
      }
    }

    prevWindow = currentWindow;
  }

  // Final segment
  const segMessages = nonSystem.slice(segStart);
  segments.push(buildSegment(segMessages, segStart, nonSystem.length - 1));

  return segments;
}

function buildSegment(msgs: Message[], start: number, end: number): TopicSegment {
  const allText = msgs.map((m) => toText(m.content)).join(" ");
  const freq = phraseFrequency([allText]);
  const keyPhrases = topN(freq, 5).filter(
    (p) => p.split(" ").length === 1 || freq.get(p)! > 1
  );
  const label = keyPhrases.slice(0, 2).join(" / ") || "general";
  return { label, startTurn: start, endTurn: end, keyPhrases };
}

// ---------------------------------------------------------------------------
// Progressive summarization
// ---------------------------------------------------------------------------

const CHUNK_SIZE = 10;

function summarizeChunk(messages: Message[], chunkIndex: number): string {
  const texts = messages
    .filter((m) => m.role !== "system" && m.role !== "tool")
    .map((m) => toText(m.content));

  if (texts.length === 0) return "";

  const freq = phraseFrequency(texts);
  const top = topN(freq, 6).filter((p) => p.length > 3);
  const decisions = detectDecisions(messages).map((d) => d.statement);
  const actions = detectActionItems(messages)
    .filter((a) => !a.completed)
    .map((a) => a.action);

  const parts: string[] = [];
  parts.push(`Chunk ${chunkIndex + 1} (${messages.length} messages).`);
  if (top.length > 0) parts.push(`Key terms: ${top.join(", ")}.`);
  if (decisions.length > 0) parts.push(`Decisions: ${decisions.slice(0, 3).join("; ")}.`);
  if (actions.length > 0) parts.push(`Pending actions: ${actions.slice(0, 3).join("; ")}.`);

  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Summarize a full conversation.
 *
 * @param messages - Array of Message objects (system + user + assistant + tool)
 * @returns ConversationSummary with overview, topics, decisions, action items
 */
export function summarizeConversation(messages: Message[]): ConversationSummary {
  const visible = messages.filter((m) => m.role !== "system");

  const progressiveSummaries: string[] = [];
  for (let i = 0; i < visible.length; i += CHUNK_SIZE) {
    const chunk = visible.slice(i, i + CHUNK_SIZE);
    const summary = summarizeChunk(chunk, Math.floor(i / CHUNK_SIZE));
    if (summary) progressiveSummaries.push(summary);
  }

  const topics = segmentTopics(visible);
  const decisions = detectDecisions(messages);
  const actionItems = detectActionItems(messages);

  const allTexts = visible.map((m) => toText(m.content));
  const freq = phraseFrequency(allTexts);
  const topPhrases = topN(freq, 10).filter((p) => p.length > 3);

  const topicLabels = topics.map((t) => t.label).join(", ");
  const decisionCount = decisions.length;
  const pendingActions = actionItems.filter((a) => !a.completed).length;
  const completedActions = actionItems.filter((a) => a.completed).length;

  let overview = `Conversation of ${visible.length} messages`;
  if (topics.length > 0) {
    overview += ` covering ${topics.length} topic${topics.length !== 1 ? "s" : ""}: ${topicLabels}`;
  }
  if (decisionCount > 0) {
    overview += `. ${decisionCount} decision${decisionCount !== 1 ? "s" : ""} detected`;
  }
  if (pendingActions > 0 || completedActions > 0) {
    overview += `. ${actionItems.length} action item${actionItems.length !== 1 ? "s" : ""} (${completedActions} completed, ${pendingActions} pending)`;
  }
  overview += ".";

  return {
    overview,
    messageCount: messages.length,
    topics,
    decisions,
    actionItems,
    topPhrases,
    progressiveSummaries,
  };
}

/**
 * Extract action items from a conversation without full summarization.
 * Faster than summarizeConversation() when you only need the action list.
 *
 * @param messages - Array of Message objects
 * @returns Array of ActionItem, sorted by turnIndex
 */
export function extractActionItems(messages: Message[]): ActionItem[] {
  return detectActionItems(messages).sort((a, b) => a.turnIndex - b.turnIndex);
}

// ---------------------------------------------------------------------------
// CLI entrypoint
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const cmd = process.argv[2] ?? "demo";

  if (cmd === "demo") {
    const demo: Message[] = [
      { role: "user", content: "Let's build a new auth system using JWT tokens." },
      {
        role: "assistant",
        content:
          "Great idea. We decided to use JWT. I will implement the token issuer first.",
      },
      { role: "user", content: "You should also add refresh token support." },
      {
        role: "assistant",
        content:
          "Agreed. We agreed to support refresh tokens. I need to update the session schema.",
      },
      { role: "user", content: "Now let's switch to the deployment pipeline." },
      {
        role: "assistant",
        content:
          "For deployment we can use Docker. Let's go with Docker Compose for local and Fly.io for prod.",
      },
      { role: "user", content: "We decided on Fly.io. Please create the fly.toml." },
      {
        role: "assistant",
        content:
          "The fly.toml has been created and tested. JWT token issuer is done.",
      },
    ];

    const summary = summarizeConversation(demo);
    console.log("=== OVERVIEW ===");
    console.log(summary.overview);
    console.log("\n=== TOPICS ===");
    for (const t of summary.topics) {
      console.log(`  [${t.startTurn}-${t.endTurn}] ${t.label} (${t.keyPhrases.join(", ")})`);
    }
    console.log("\n=== DECISIONS ===");
    for (const d of summary.decisions) {
      console.log(`  [turn ${d.turnIndex}] (${d.speaker}) ${d.statement}`);
    }
    console.log("\n=== ACTION ITEMS ===");
    for (const a of extractActionItems(demo)) {
      const status = a.completed ? "done   " : "pending";
      console.log(`  [turn ${a.turnIndex}] [${status}] (${a.owner}) ${a.action}`);
    }
    console.log("\n=== TOP PHRASES ===");
    console.log(" ", summary.topPhrases.join(", "));
    console.log("\n=== PROGRESSIVE SUMMARIES ===");
    for (const s of summary.progressiveSummaries) console.log(" ", s);
  } else {
    console.error(
      `Unknown command: ${cmd}. Usage: bun packages/eight/conversation-summarizer.ts demo`
    );
    process.exit(1);
  }
}
