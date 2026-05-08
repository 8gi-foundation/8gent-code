/**
 * Evaluates and scores a potential business partner based on strategic fit, reach, and risk.
 * @param partner - Partner details including audience overlap, tech compatibility, brand alignment, and risk.
 * @returns Composite score between 0 and 1.
 */
export function scorePartner(partner: { name: string; audienceOverlap: number; techCompatibility: number; brandAlignment: number; risk: number }): number {
  const strategicFit = (partner.audienceOverlap + partner.brandAlignment) / 2;
  const reach = partner.techCompatibility;
  const riskFactor = 1 - partner.risk;
  return strategicFit * 0.5 + reach * 0.3 + riskFactor * 0.2;
}

/**
 * Ranks partners by their composite score in descending order.
 * @param partners - Array of partner objects.
 * @returns Sorted list of partners with scores.
 */
export function rank(partners: { name: string; audienceOverlap: number; techCompatibility: number; brandAlignment: number; risk: number }[]): { name: string; score: number }[] {
  return partners.map(p => ({ ...p, score: scorePartner(p) })).sort((a, b) => b.score - a.score);
}

/**
 * Renders a formatted evaluation card for a partner.
 * @param partner - Partner details.
 * @returns Formatted string with evaluation metrics.
 */
export function renderScorecard(partner: { name: string; audienceOverlap: number; techCompatibility: number; brandAlignment: number; risk: number }): string {
  const strategicFit = (partner.audienceOverlap + partner.brandAlignment) / 2;
  const reach = partner.techCompatibility;
  const riskFactor = 1 - partner.risk;
  const score = scorePartner(partner);
  return `${partner.name}\nStrategic Fit: ${strategicFit.toFixed(2)}\nReach: ${reach.toFixed(2)}\nRisk: ${riskFactor.toFixed(2)}\nTotal: ${score.toFixed(2)}`;
}

/**
 * Compares two partners side-by-side on key dimensions.
 * @param a - First partner.
 * @param b - Second partner.
 * @returns Formatted comparison table.
 */
export function comparePartners(a: { name: string; audienceOverlap: number; techCompatibility: number; brandAlignment: number; risk: number }, b: { name: string; audienceOverlap: number; techCompatibility: number; brandAlignment: number; risk: number }): string {
  const scoreA = scorePartner(a);
  const scoreB = scorePartner(b);
  return `Name | ${a.name} | ${b.name}\nAudience Overlap | ${a.audienceOverlap} | ${b.audienceOverlap}\nTech Compatibility | ${a.techCompatibility} | ${b.techCompatibility}\nBrand Alignment | ${a.brandAlignment} | ${b.brandAlignment}\nRisk | ${a.risk} | ${b.risk}\nScore | ${scoreA.toFixed(2)} | ${scoreB.toFixed(2)}`;
}