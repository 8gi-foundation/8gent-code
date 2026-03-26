/**
 * Adds feedback to the pool.
 * @param pool - The pool of feedback items.
 * @param feedback - The feedback object with text, source, date, and optional rating.
 */
export function addFeedback(pool: Feedback[], feedback: { text: string; source: string; date: Date; rating?: number }): void {
  pool.push(feedback);
}

/**
 * Groups feedback by matching keywords.
 * @param pool - The pool of feedback items.
 * @param keywords - Array of keywords to cluster by.
 * @returns Object mapping keywords to feedback items.
 */
export function clusterByKeyword(pool: Feedback[], keywords: string[]): Record<string, Feedback[]> {
  const result: Record<string, Feedback[]> = {};
  for (const keyword of keywords) result[keyword] = [];
  for (const feedback of pool) {
    for (const keyword of keywords) {
      if (feedback.text.includes(keyword)) result[keyword].push(feedback);
    }
  }
  return result;
}

/**
 * Summarizes sentiment from feedback.
 * @param pool - The pool of feedback items.
 * @returns Object with positive, neutral, and negative counts.
 */
export function sentimentSummary(pool: Feedback[]): { positive: number; neutral: number; negative: number } {
  const counts = { positive: 0, neutral: 0, negative: 0 };
  const positiveWords = ['good', 'excellent', 'great'];
  const negativeWords = ['bad', 'terrible', 'poor'];
  for (const feedback of pool) {
    if (feedback.rating !== undefined) {
      if (feedback.rating >= 4) counts.positive++;
      else if (feedback.rating === 3) counts.neutral++;
      else counts.negative++;
    } else {
      let positive = 0, negative = 0;
      for (const word of positiveWords) {
        if (feedback.text.toLowerCase().includes(word)) positive++;
      }
      for (const word of negativeWords) {
        if (feedback.text.toLowerCase().includes(word)) negative++;
      }
      if (positive > negative) counts.positive++;
      else if (negative > positive) counts.negative++;
      else counts.neutral++;
    }
  }
  return counts;
}

/**
 * Returns most frequent themes with example quotes.
 * @param pool - The pool of feedback items.
 * @param n - Number of themes to return.
 * @returns Array of theme objects with count and example.
 */
export function topThemes(pool: Feedback[], n: number): { theme: string; count: number; example: string }[] {
  const wordCounts: Record<string, number> = {};
  for (const feedback of pool) {
    const words = feedback.text.toLowerCase().match(/\b\w+\b/g) || [];
    for (const word of words) {
      wordCounts[word] = (wordCounts[word] || 0) + 1;
    }
  }
  const sorted = Object.entries(wordCounts).sort((a, b) => b[1] - a[1]);
  return sorted.slice(0, n).map(([word, count]) => {
    const example = pool.find(f => f.text.toLowerCase().includes(word))?.text || '';
    return { theme: word, count, example };
  });
}

/**
 * Generates markdown report with themes and sample feedback.
 * @param pool - The pool of feedback items.
 * @returns Markdown string with report.
 */
export function renderReport(pool: Feedback[]): string {
  const themes = topThemes(pool, 5);
  const sentiment = sentimentSummary(pool);
  return `# Feedback Report\n\n## Sentiment Summary\n- Positive: ${sentiment.positive}\n- Neutral: ${sentiment.neutral}\n- Negative: ${sentiment.negative}\n\n## Top Themes\n${themes.map(t => `### ${t.theme} (${t.count})\n> ${t.example}`).join('\n\n')}`;
}

/**
 * Feedback item type.
 */
export type Feedback = {
  text: string;
  source: string;
  date: Date;
  rating?: number;
};