/**
 * Utility for selecting few-shot examples based on semantic similarity.
 */
export interface Example {
  id: string;
  input: string;
  output: string;
  tags: string[];
}

/**
 * Adds an example to the pool.
 * @param pool - The pool of examples.
 * @param example - The example to add.
 */
export function addExample(pool: Example[], example: { input: string; output: string; tags?: string[] }): void {
  pool.push({
    id: Math.random().toString(36).substring(2, 9),
    input: example.input,
    output: example.output,
    tags: example.tags || [],
  });
}

/**
 * Selects the top k examples from the pool based on similarity score.
 * @param pool - The pool of examples.
 * @param query - The current input to compare against.
 * @param k - Number of examples to return.
 * @param scoreFn - Function to compute similarity score.
 * @returns The k most relevant examples.
 */
export function select(pool: Example[], query: string, k: number, scoreFn: (query: string, input: string) => number): Example[] {
  return pool
    .map((example) => ({ ...example, score: scoreFn(query, example.input) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

/**
 * Formats examples as chat messages or Q/A blocks.
 * @param examples - Examples to format.
 * @param format - 'chat' for conversation style, 'qa' for Q/A blocks.
 * @returns Formatted examples.
 */
export function formatExamples(examples: Example[], format: 'chat' | 'qa' = 'qa'): string[] {
  return examples.map((example) => {
    if (format === 'chat') {
      return `User: ${example.input}\nAssistant: ${example.output}`;
    } else {
      return `Q: ${example.input}\nA: ${example.output}`;
    }
  });
}

/**
 * Ensures category balance in example selection.
 * @param pool - The pool of examples.
 * @param query - The current input to compare against.
 * @param k - Number of examples to return.
 * @param tagKey - The tag key to balance by.
 * @param scoreFn - Function to compute similarity score.
 * @returns Balanced selection of examples.
 */
export function balanced(
  pool: Example[],
  query: string,
  k: number,
  tagKey: string,
  scoreFn: (query: string, input: string) => number
): Example[] {
  const groups = new Map<string, Example[]>();
  for (const example of pool) {
    const tag = example.tags.find((t) => t === tagKey);
    if (tag) {
      if (!groups.has(tag)) groups.set(tag, []);
      groups.get(tag)!.push(example);
    }
  }

  const candidates: Example[] = [];
  for (const [tag, group] of groups.entries()) {
    const scored = group.map((ex) => ({ ...ex, score: scoreFn(query, ex.input) }));
    scored.sort((a, b) => b.score - a.score);
    candidates.push(scored[0]);
  }

  return candidates
    .sort((a, b) => b.score - a.score)
    .concat(pool.filter((ex) => !candidates.some((c) => c.id === ex.id)))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}