/**
 * Study sessions — periodic self-reflection that turns feedback into knowledge.
 *
 * Designed to be called by the agent loop during idle time.
 */

import type { KnowledgeBase } from "./index.js";
import type { FeedbackCollector, FeedbackPattern } from "./feedback.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StudyResult {
  entriesAdded: number;
  entriesRemoved: number;
  patternsFound: string[];
}

// ---------------------------------------------------------------------------
// StudySession
// ---------------------------------------------------------------------------

export class StudySession {
  /**
   * Run a study session: analyze feedback, derive patterns, update knowledge.
   *
   * This is intentionally synchronous-safe (async signature for future LLM
   * integration) and deterministic so it can run without network access.
   */
  async runStudy(
    knowledgeBase: KnowledgeBase,
    feedback: FeedbackCollector
  ): Promise<StudyResult> {
    const result: StudyResult = {
      entriesAdded: 0,
      entriesRemoved: 0,
      patternsFound: [],
    };

    // 1. Prune stale knowledge
    result.entriesRemoved = knowledgeBase.prune();

    // 2. Analyze feedback patterns
    const patterns: FeedbackPattern[] = feedback.getPatterns();
    for (const p of patterns) {
      result.patternsFound.push(`${p.pattern} (${p.trend})`);
    }

    // 3. Generate new knowledge entries from declining patterns
    const decliningPatterns = patterns.filter((p) => p.trend === "declining");
    for (const dp of decliningPatterns) {
      // Avoid duplicating existing knowledge
      const existing = knowledgeBase.search(dp.pattern, 1);
      if (existing.length > 0 && (existing[0].score ?? 0) > 1) {
        continue; // Already well-covered
      }

      knowledgeBase.add({
        content: `Feedback pattern: ${dp.pattern}. Consider adjusting approach.`,
        category: "pattern",
        source: "study-session",
      });
      result.entriesAdded++;
    }

    // 4. Capture high-rejection contexts as error knowledge
    const feedbackEntries = feedback.getAll();
    const recentRejections = feedbackEntries
      .filter(
        (e) =>
          (e.outcome === "rejected" || e.outcome === "reverted") && e.context
      )
      .slice(-10);

    // Group by context and find repeated issues
    const contextFreq = new Map<string, number>();
    for (const r of recentRejections) {
      const ctx = r.context!.toLowerCase().trim();
      contextFreq.set(ctx, (contextFreq.get(ctx) ?? 0) + 1);
    }

    for (const [ctx, freq] of contextFreq) {
      if (freq >= 2) {
        const existing = knowledgeBase.search(ctx, 1);
        if (existing.length > 0 && (existing[0].score ?? 0) > 1) {
          continue;
        }

        knowledgeBase.add({
          content: `Repeated rejection in context: "${ctx}". This area needs improvement.`,
          category: "error",
          source: "study-session",
        });
        result.entriesAdded++;
      }
    }

    // 5. Record acceptance rate as a preference entry (if meaningful data)
    if (feedbackEntries.length >= 10) {
      const rate = feedback.getAcceptanceRate();
      const rateStr = `Current acceptance rate: ${(rate * 100).toFixed(0)}%`;
      const existing = knowledgeBase.search("acceptance rate", 1);

      if (existing.length === 0 || existing[0].source === "study-session") {
        // Update or create the rate entry
        if (existing.length > 0 && existing[0].source === "study-session") {
          // Already have one — only add if rate changed significantly
          const prevMatch = existing[0].content.match(/(\d+)%/);
          const prevRate = prevMatch ? parseInt(prevMatch[1]) : 0;
          if (Math.abs(rate * 100 - prevRate) < 5) {
            return result; // No significant change
          }
        }

        knowledgeBase.add({
          content: rateStr,
          category: "preference",
          source: "study-session",
        });
        result.entriesAdded++;
      }
    }

    return result;
  }
}
