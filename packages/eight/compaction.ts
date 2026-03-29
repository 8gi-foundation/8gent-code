/**
 * Context Compaction Engine
 * LLM-summarized context management for long sessions. When estimated tokens
 * approach the context window limit, older messages are summarized and replaced
 * with a structured checkpoint so the agent can continue indefinitely.
 * @author podjamz
 */
import { generateText } from "ai";
import type { LanguageModel } from "ai";

export interface CompactionConfig {
  enabled: boolean;
  reserveTokens: number;
  keepRecentTokens: number;
  contextWindow: number; // 0 = auto-detect from model
}

export const DEFAULT_COMPACTION_CONFIG: CompactionConfig = {
  enabled: true,
  reserveTokens: 16384,
  keepRecentTokens: 20000,
  contextWindow: 0,
};

export interface CompactionResult {
  summary: string; tokensBefore: number; tokensAfter: number;
  messagesRemoved: number; filesRead: string[]; filesModified: string[];
}
type Message = { role: string; content: string };

export class FileTracker {
  readonly read = new Set<string>();
  readonly modified = new Set<string>();

  trackRead(path: string) { this.read.add(path); }
  trackModified(path: string) { this.modified.add(path); }

  merge(other: FileTracker) {
    Array.from(other.read).forEach(p => this.read.add(p));
    Array.from(other.modified).forEach(p => this.modified.add(p));
  }

  getSummary(): string {
    const lines: string[] = ["## Files Touched"];
    if (this.read.size > 0)
      lines.push("### Read", ...Array.from(this.read).map(f => `- ${f}`));
    if (this.modified.size > 0)
      lines.push("### Modified", ...Array.from(this.modified).map(f => `- ${f}`));
    return lines.join("\n");
  }
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function estimateMessageTokens(messages: Message[]): number {
  let total = 0;
  for (const m of messages) total += estimateTokens(m.content) + 4;
  return total;
}

// Extract file paths from tool call JSON in message content
const READ_RE = [
  /read_file[^"]*"(?:file_?path|path)":\s*"([^"]+)"/gi,
  /cat\s+([^\s;|&]+)/gi,
];
const WRITE_RE = [
  /write_file[^"]*"(?:file_?path|path)":\s*"([^"]+)"/gi,
  /edit_file[^"]*"(?:file_?path|path)":\s*"([^"]+)"/gi,
];

function extractFiles(messages: Message[]): FileTracker {
  const tracker = new FileTracker();
  for (const m of messages) {
    for (const pat of READ_RE) {
      pat.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pat.exec(m.content)) !== null) tracker.trackRead(match[1]);
    }
    for (const pat of WRITE_RE) {
      pat.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pat.exec(m.content)) !== null) tracker.trackModified(match[1]);
    }
  }
  return tracker;
}

const PROMPT_SUFFIX = "a structured context checkpoint for another LLM to continue.\nPreserve exact file paths, function names, and error messages.\n\n## Goal        - what the user is trying to accomplish\n## Constraints - requirements and preferences mentioned\n## Progress    - Done [x], In Progress [ ], Blocked\n## Decisions   - key choices with brief rationale\n## Next Steps  - ordered list of what should happen next\n## Context     - data, examples, references needed to continue";

export class CompactionEngine {
  private config: CompactionConfig;
  private fileTracker = new FileTracker();
  private previousSummary: string | null = null;

  constructor(config: Partial<CompactionConfig> = {}) {
    this.config = { ...DEFAULT_COMPACTION_CONFIG, ...config };
  }

  shouldCompact(messages: Message[], contextWindow?: number): boolean {
    if (!this.config.enabled) return false;
    const cw = contextWindow || this.config.contextWindow || 32768;
    return estimateMessageTokens(messages) > (cw - this.config.reserveTokens);
  }

  private findCutPoint(messages: Message[]): number {
    let accumulated = 0;
    let cutIdx = messages.length;
    for (let i = messages.length - 1; i > 0; i--) {
      accumulated += estimateTokens(messages[i].content) + 4;
      if (accumulated >= this.config.keepRecentTokens) { cutIdx = i; break; }
    }
    if (cutIdx <= 1) return 1;
    // Never split tool call/result pairs
    if (messages[cutIdx].role === "tool") cutIdx = Math.max(1, cutIdx - 1);
    // Never split user/assistant turn pairs
    if (cutIdx > 1 && messages[cutIdx].role === "assistant" && messages[cutIdx - 1]?.role === "user")
      cutIdx = cutIdx - 1;
    return cutIdx;
  }

  async compact(
    messages: Message[],
    model: LanguageModel,
    contextWindow?: number,
  ): Promise<{ messages: Message[]; result: CompactionResult }> {
    const tokensBefore = estimateMessageTokens(messages);
    const cutPoint = this.findCutPoint(messages);
    const systemMsg = messages[0];
    const toSummarize = messages.slice(1, cutPoint);
    const toKeep = messages.slice(cutPoint);

    // Track files from messages about to be discarded
    this.fileTracker.merge(extractFiles(toSummarize));

    const serialized = toSummarize
      .map(m => `[${m.role}]: ${m.content.slice(0, 2000)}`)
      .join("\n\n");
    const action = this.previousSummary ? "Update" : "Create";
    const prevBlock = this.previousSummary
      ? `<previous-summary>\n${this.previousSummary}\n</previous-summary>\n\n`
      : "";
    const prompt = `<conversation>\n${serialized}\n</conversation>\n\n${prevBlock}${action} ${PROMPT_SUFFIX}`;

    const { text: summary } = await generateText({
      model, prompt, maxOutputTokens: 1500,
    });

    const fullSummary = `${summary}\n\n${this.fileTracker.getSummary()}`;
    this.previousSummary = fullSummary;

    const summaryMsg: Message = {
      role: "system",
      content: `[Context Compaction Summary]\n\n${fullSummary}`,
    };
    const compactedMessages = [systemMsg, summaryMsg, ...toKeep];
    const tokensAfter = estimateMessageTokens(compactedMessages);

    return {
      messages: compactedMessages,
      result: {
        summary: fullSummary, tokensBefore, tokensAfter,
        messagesRemoved: toSummarize.length,
        filesRead: Array.from(this.fileTracker.read),
        filesModified: Array.from(this.fileTracker.modified),
      },
    };
  }

  getFileTracker(): FileTracker { return this.fileTracker; }
}
