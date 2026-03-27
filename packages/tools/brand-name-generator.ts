/**
 * Options for generating brand names.
 */
type GenerateOptions = {
  maxCandidates?: number;
};

/**
 * Generates brand name candidates from keywords using various patterns.
 * @param keywords - List of keywords to generate names from.
 * @param options - Optional configuration.
 * @returns Array of generated name candidates.
 */
export function generate(keywords: string[], options: GenerateOptions = {}): string[] {
  const { maxCandidates = 20 } = options;
  const candidates: Set<string> = new Set();

  // Compound
  for (let i = 0; i < keywords.length; i++) {
    for (let j = i + 1; j < keywords.length; j++) {
      const a = keywords[i];
      const b = keywords[j];
      candidates.add(a + b);
      candidates.add(b + a);
      candidates.add(a.substring(0, 2) + b.substring(0, 2));
    }
  }

  // Portmanteau
  for (let i = 0; i < keywords.length; i++) {
    for (let j = 0; j < keywords.length; j++) {
      if (i !== j) {
        const a = keywords[i];
        const b = keywords[j];
        const mid = Math.floor(a.length / 2);
        candidates.add(a.slice(0, mid) + b.slice(mid));
      }
    }
  }

  // Initialism
  for (const keyword of keywords) {
    const words = keyword.split(' ');
    const initials = words.map(word => word[0]).join('');
    candidates.add(initials);
  }

  // Truncation
  for (const keyword of keywords) {
    candidates.add(keyword.substring(0, 3));
    candidates.add(keyword.substring(0, 4));
  }

  // Metaphor (placeholder)
  for (const keyword of keywords) {
    candidates.add(keyword);
  }

  return Array.from(candidates).slice(0, maxCandidates);
}

/**
 * Scores a brand name based on memorability, pronounceability, and domain-friendliness.
 * @param name - The name to score.
 * @returns Score between 0 and 30.
 */
export function score(name: string): number {
  const lengthScore = 10 - name.length;
  const vowelScore = (name.match(/[aeiou]/gi) || []).length * 2;
  const domainScore = name.includes('-') ? 5 : 10;
  return lengthScore + vowelScore + domainScore;
}

/**
 * Filters names for likely-available domains.
 * @param names - List of names to filter.
 * @param domainSuffix - Optional domain suffix (e.g., '.com').
 * @returns Filtered list of names.
 */
export function filter(names: string[], domainSuffix: string = '.com'): string[] {
  return names.filter(name => name.length <= 8 && !name.includes('-'));
}

/**
 * Renders a shortlist of scored brand names.
 * @param names - List of names with scores.
 * @returns Rendered report as an array of objects with name and score.
 */
export function renderReport(names: { name: string; score: number }[]): { name: string; score: number }[] {
  return names.sort((a, b) => b.score - a.score).slice(0, 20);
}