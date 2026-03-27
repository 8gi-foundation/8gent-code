/**
 * Extracts hashtag candidates from text by filtering common words and adding #.
 * @param text - Input content to analyze.
 * @returns Array of candidate hashtags.
 */
function extract(text: string): string[] {
  const stopWords = new Set(['the', 'and', 'of', 'to', 'a', 'in', 'is', 'it', 'this', 'that']);
  return [...new Set(
    text.toLowerCase().split(/\s+/)
      .filter(word => !stopWords.has(word) && word.length >= 3)
      .map(word => `#${word}`)
  )];
}

/**
 * Categorizes hashtags into niche, medium, large based on volume ranges.
 * @param hashtags - Array of hashtags to categorize.
 * @param volumes - Object mapping hashtags to their volume (reach) numbers.
 * @returns Object with categories as keys and arrays of hashtags as values.
 */
function categorize(hashtags: string[], volumes: Record<string, number>): Record<string, string[]> {
  const categories: Record<string, string[]> = { niche: [], medium: [], large: [] };
  for (const tag of hashtags) {
    const volume = volumes[tag] || 0;
    if (volume <= 1000) categories.niche.push(tag);
    else if (volume <= 10000) categories.medium.push(tag);
    else categories.large.push(tag);
  }
  return categories;
}

/**
 * Builds a balanced hashtag set from content using specified category quotas.
 * @param content - Input content to generate hashtags from.
 * @param config - Configuration object with quotas for niche, medium, broad categories.
 * @returns Array of selected hashtags.
 */
function buildSet(content: string, config: { niche: number; medium: number; broad: number }): string[] {
  const volumes: Record<string, number> = {
    '#tech': 5000, '#ai': 8000, '#socialmedia': 15000, '#startup': 2000, '#innovation': 12000
  };
  const hashtags = extract(content);
  const categories = categorize(hashtags, volumes);
  const selected: string[] = [];
  for (const [category, quota] of Object.entries(config)) {
    const pool = categories[category as keyof typeof categories];
    selected.push(...pool.slice(0, quota));
  }
  return selected;
}

/**
 * Renders the hashtag strategy with rationale for selected tags.
 * @param set - Array of selected hashtags.
 * @returns Formatted strategy string with rationale.
 */
function renderStrategy(set: string[]): string {
  return `Hashtag Strategy:\n${set.join(', ')}\n\nRationale: Balanced mix of niche, medium, and broad reach tags to maximize engagement and audience reach.`;
}

export { extract, categorize, buildSet, renderStrategy };