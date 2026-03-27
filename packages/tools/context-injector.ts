interface Segment {
  key: string;
  content: string;
  priority: number;
  tags: string[];
  tokens: number;
}

interface Injector {
  segments: Segment[];
}

/**
 * Adds a segment to the injector.
 * @param injector - The injector object.
 * @param params - The segment parameters.
 */
function addSegment(injector: Injector, { key, content, priority, tags }: { key: string; content: string; priority: number; tags: string[] }): void {
  const tokens = content.length;
  injector.segments.push({ key, content, priority, tags, tokens });
}

/**
 * Builds the context string within the token budget.
 * @param injector - The injector object.
 * @param query - The query string.
 * @param budget - The token budget.
 * @param scoreFn - Function to calculate relevance score.
 * @returns Context string within budget.
 */
function build(injector: Injector, query: string, budget: number, scoreFn: (query: string, segment: Segment) => number): string {
  const scoredSegments = injector.segments.map(segment => ({
    ...segment,
    score: scoreFn(query, segment)
  }));

  scoredSegments.sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    return b.score! - a.score!;
  });

  let totalTokens = 0;
  const selected: Segment[] = [];

  for (const segment of scoredSegments) {
    if (totalTokens + segment.tokens <= budget) {
      selected.push(segment);
      totalTokens += segment.tokens;
    } else {
      break;
    }
  }

  return selected.map(s => s.content).join(' ');
}

/**
 * Refreshes a segment's content.
 * @param injector - The injector object.
 * @param key - The segment key.
 * @param newContent - New content for the segment.
 */
function refresh(injector: Injector, key: string, newContent: string): void {
  const segment = injector.segments.find(s => s.key === key);
  if (segment) {
    segment.content = newContent;
    segment.tokens = newContent.length;
  }
}

/**
 * Renders segments as a table.
 * @param injector - The injector object.
 * @returns Table of segments with priority and token count.
 */
function renderSegments(injector: Injector): { key: string; priority: number; tokens: number; tags: string[] }[] {
  return injector.segments.map(segment => ({
    key: segment.key,
    priority: segment.priority,
    tokens: segment.tokens,
    tags: segment.tags
  }));
}

export { addSegment, build, refresh, renderSegments };