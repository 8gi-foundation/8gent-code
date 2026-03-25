# Quarantine: conversation-summarizer

## What

Zero-dependency progressive summarization of agent conversation histories. Extracts decisions, action items, and topics from `Message[]` arrays using pattern matching and word-overlap heuristics. No AI calls. No external deps.

## File

`packages/eight/conversation-summarizer.ts` (~310 lines)

## API

```ts
import {
  summarizeConversation,
  extractActionItems,
} from './packages/eight/conversation-summarizer.ts';
import type {
  ConversationSummary,
  ActionItem,
  Decision,
  TopicSegment,
} from './packages/eight/conversation-summarizer.ts';

// Full summary
const summary: ConversationSummary = summarizeConversation(messages);
summary.overview              // one-paragraph plain-English description
summary.messageCount          // total messages including system/tool
summary.topics                // TopicSegment[] - detected topic shifts
summary.decisions             // Decision[] - sentences that contain a commitment
summary.actionItems           // ActionItem[] - things to do (with completion detection)
summary.topPhrases            // string[] - top 10 key phrases by frequency
summary.progressiveSummaries  // string[] - one summary per 10-message chunk

// Action items only (faster)
const items: ActionItem[] = extractActionItems(messages);
items[0].action     // "I will implement the token issuer first."
items[0].owner      // "assistant" | "user" | "unspecified"
items[0].turnIndex  // 1
items[0].completed  // true (if a later message references it as done)
```

### Types

```ts
interface Decision {
  statement: string;
  turnIndex: number;
  speaker: "user" | "assistant";
}

interface ActionItem {
  action: string;
  owner: "user" | "assistant" | "unspecified";
  turnIndex: number;
  completed: boolean;
}

interface TopicSegment {
  label: string;        // top-2 key phrases joined by " / "
  startTurn: number;
  endTurn: number;
  keyPhrases: string[];
}

interface ConversationSummary {
  overview: string;
  messageCount: number;
  topics: TopicSegment[];
  decisions: Decision[];
  actionItems: ActionItem[];
  topPhrases: string[];
  progressiveSummaries: string[];
}
```

## CLI demo

```bash
bun packages/eight/conversation-summarizer.ts demo
```

## How it works

| Feature | Approach |
|---------|---------|
| Decision detection | Regex patterns for commitment phrases ("we decided", "let's go with", etc.) - weighted scoring, threshold >= 2 |
| Action item detection | Regex patterns for imperative/obligation phrases ("I will", "you should", "TODO", bullet points) |
| Completion detection | Later messages with completion words ("done", "implemented", "shipped") cross-referenced by word overlap with action text |
| Topic segmentation | Sliding-window (size 4) phrase-overlap ratio - shift triggered when overlap drops below 15% |
| Progressive summaries | Chunked every 10 messages, each chunk summarized independently |
| Key phrases | Bigram + unigram frequency after stop-word filtering |

## Why quarantined

New file, no CI coverage yet. Needs:

- [ ] Unit tests with varied conversation shapes (short, long, no decisions, all tool calls)
- [ ] Tune decision/action thresholds against a labeled sample of real 8gent conversations
- [ ] Evaluate topic segmentation quality on multi-topic sessions from autoresearch logs
- [ ] Wire into `packages/memory/store.ts` as a consolidation input
- [ ] Consider as a compression step before injecting history into the system prompt
- [ ] Possibly wire into `packages/eight/session-sync.ts` to persist summaries per checkpoint
