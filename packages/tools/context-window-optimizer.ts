/**
 * Represents an item with text and a relevance score.
 */
export interface Item {
  text: string;
  score: number;
}

/**
 * Represents the result of the fit function, containing selected items and overflow details.
 */
export interface SelectedItems {
  selected: Item[];
  overflow: OverflowItem[];
}

/**
 * Represents an item that was excluded from the selection along with the reason.
 */
export interface OverflowItem {
  item: Item;
  reason: string;
}

/**
 * Sorts items by relevance score in descending order.
 * @param items - Array of items to prioritize.
 * @param scoreFn - Function to compute relevance score for each item.
 * @returns Sorted items array.
 */
export function prioritize(items: Item[], scoreFn: (item: Item) => number): Item[] {
  return [...items].sort((a, b) => scoreFn(b) - scoreFn(a));
}

/**
 * Truncates text to maxTokens, preserving sentence boundaries.
 * @param text - Text to truncate.
 * @param maxTokens - Maximum allowed tokens.
 * @param tokenizerFn - Optional function to count tokens.
 * @returns Truncated text.
 */
export function trim(text: string, maxTokens: number, tokenizerFn?: (s: string) => number): string {
  const sentences = text.split(/([.!?])\s*/);
  let result = '';
  let tokenCount = 0;
  for (let i = 0; i < sentences.length; i += 2) {
    const sentence = sentences[i];
    const tempResult = result + sentence;
    const tempCount = tokenizerFn ? tokenizerFn(tempResult) : tempResult.split(' ').length;
    if (tempCount <= maxTokens) {
      result = tempResult;
      tokenCount = tempCount;
    } else {
      break;
    }
  }
  return result;
}

/**
 * Selects items within token budget using priority-based selection.
 * @param items - Array of items to select from.
 * @param tokenBudget - Maximum allowed tokens.
 * @param tokenizerFn - Optional function to count tokens.
 * @returns Object with selected items and overflow details.
 */
export function fit(items: Item[], tokenBudget: number, tokenizerFn?: (s: string) => number): SelectedItems {
  const prioritized = prioritize(items, (item) => item.score);
  const selected: Item[] = [];
  let totalTokens = 0;
  const overflow: OverflowItem[] = [];
  for (const item of prioritized) {
    const availableTokens = tokenBudget - totalTokens;
    if (availableTokens <= 0) {
      overflow.push({ item, reason: 'exceeded token budget' });
      continue;
    }
    const trimmedText = trim(item.text, availableTokens, tokenizerFn);
    const trimmedTokenCount = tokenizerFn ? tokenizerFn(trimmedText) : trimmedText.split(' ').length;
    if (totalTokens + trimmedTokenCount <= tokenBudget) {
      selected.push({ ...item, text: trimmedText });
      totalTokens += trimmedTokenCount;
    } else {
      overflow.push({ item, reason: 'exceeded token budget after trimming' });
    }
  }
  return { selected, overflow };
}

/**
 * Summarizes excluded items and reasons.
 * @param overflow - Array of excluded items and reasons.
 * @returns Summary string.
 */
export function summarizeOverflow(overflow: OverflowItem[]): string {
  return overflow.map(item => `Excluded: ${item.item.text} - Reason: ${item.reason}`).join('\n');
}