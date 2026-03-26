/**
 * Risk register entry with probability, impact, owner, and mitigation.
 */
interface Risk {
  description: string;
  probability: number;
  impact: number;
  owner: string;
  mitigation: string;
}

/**
 * Adds a risk to the register.
 * @param register - The risk register array.
 * @param risk - The risk object with description, probability, impact, owner, and mitigation.
 */
function addRisk(register: Risk[], risk: Omit<Risk, 'score'>): void {
  register.push(risk);
}

/**
 * Calculates the risk score as probability multiplied by impact.
 * @param risk - The risk object.
 * @returns The risk score.
 */
function riskScore(risk: Risk): number {
  return risk.probability * risk.impact;
}

/**
 * Classifies a risk based on its score.
 * @param risk - The risk object.
 * @returns The classification: critical, high, medium, or low.
 */
function classify(risk: Risk): 'critical' | 'high' | 'medium' | 'low' {
  const score = riskScore(risk);
  if (score >= 15) return 'critical';
  if (score >= 9) return 'high';
  if (score >= 5) return 'medium';
  return 'low';
}

/**
 * Renders an ASCII 5x5 probability-impact heat map.
 * @param register - The risk register array.
 * @returns The ASCII heat map string.
 */
function renderHeatMap(register: Risk[]): string {
  const counts: number[][] = Array(5).fill(0).map(() => Array(5).fill(0));
  for (const risk of register) {
    const prob = Math.round(risk.probability);
    const impact = Math.round(risk.impact);
    const probIndex = 5 - prob;
    const impactIndex = impact - 1;
    if (probIndex >= 0 && probIndex < 5 && impactIndex >= 0 && impactIndex < 5) {
      counts[probIndex][impactIndex]++;
    }
  }

  let map = '';
  for (let row = 0; row < 5; row++) {
    map += 'P' + (5 - row) + ' ';
    for (let col = 0; col < 5; col++) {
      const count = counts[row][col];
      let char = '·';
      if (count > 0) {
        char = count > 5 ? '■' : count > 2 ? '●' : '○';
      }
      map += char + ' ';
    }
    map += '\n';
  }
  map += '  I 1 2 3 4 5\n';
  return map;
}

/**
 * Returns the top N risks by score.
 * @param register - The risk register array.
 * @param n - The number of top risks to return.
 * @returns An array of the top N risks.
 */
function topRisks(register: Risk[], n: number): Risk[] {
  return [...register].sort((a, b) => riskScore(b) - riskScore(a)).slice(0, n);
}

export { addRisk, riskScore, classify, renderHeatMap, topRisks };