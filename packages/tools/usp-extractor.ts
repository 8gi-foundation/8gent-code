/**
 * Extracts potential USPs from text as bullet points.
 * @param text - Product description or feature list.
 * @returns Array of USP candidates.
 */
export function extract(text: string): string[] {
  const sentences = text.match(/[^.!?]+[.!?]/g) || [];
  return sentences
    .map(s => s.trim())
    .filter(s => s.length > 10 && !/^\s*$/.test(s));
}

/**
 * Ranks USPs by uniqueness against competitor features.
 * @param usps - Array of USP candidates.
 * @param competitorFeatures - Competitor feature list.
 * @returns Sorted USPs by uniqueness.
 */
export function rank(usps: string[], competitorFeatures: string[]): string[] {
  return [...usps].sort((a, b) => {
    const aScore = uspsSimilarity(a, competitorFeatures);
    const bScore = uspsSimilarity(b, competitorFeatures);
    return aScore - bScore;
  });
}

/**
 * Generates a 30-second elevator pitch from top USPs.
 * @param usps - Ranked USP array.
 * @param audience - Target audience (not used in current implementation).
 * @returns Concise pitch.
 */
export function elevatorPitch(usps: string[], audience: string): string {
  return usps.slice(0, 3).join(' ') + '.';
}

/**
 * Validates a USP for buzzwords and specificity.
 * @param usp - Candidate USP.
 * @returns True if valid, false otherwise.
 */
export function validateUSP(usp: string): boolean {
  const buzzwords = ['innovative', 'cutting-edge', 'revolutionary'];
  return !buzzwords.some(word => usp.toLowerCase().includes(word)) && 
         usp.split(' ').length >= 5;
}

/**
 * Helper to calculate similarity score between USP and competitors.
 */
function uspsSimilarity(usp: string, competitors: string[]): number {
  const uspWords = new Set(usp.toLowerCase().split(' '));
  let score = 0;
  for (const feature of competitors) {
    const featureWords = new Set(feature.toLowerCase().split(' '));
    let overlap = 0;
    for (const word of uspWords) {
      if (featureWords.has(word)) overlap++;
    }
    score += overlap / Math.sqrt(uspWords.size * featureWords.size);
  }
  return score;
}