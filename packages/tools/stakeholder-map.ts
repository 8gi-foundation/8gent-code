/**
 * Stakeholder type definition
 */
type Stakeholder = {
  name: string;
  role: string;
  influence: number;
  interest: number;
  sentiment: number;
};

/**
 * Adds a stakeholder to the map
 * @param map - Array of stakeholders
 * @param stakeholder - Stakeholder object
 */
export function addStakeholder(map: Stakeholder[], stakeholder: Stakeholder): void {
  map.push(stakeholder);
}

/**
 * Determines the quadrant for a stakeholder
 * @param stakeholder - Stakeholder object
 * @returns Quadrant string
 */
export function quadrant(stakeholder: Stakeholder): string {
  const { influence, interest } = stakeholder;
  if (influence > 50 && interest > 50) return 'manage-closely';
  if (influence > 50 && interest <= 50) return 'keep-satisfied';
  if (influence <= 50 && interest > 50) return 'keep-informed';
  return 'monitor';
}

/**
 * Generates communication plan by quadrant
 * @param map - Array of stakeholders
 * @returns Communication plan object
 */
export function communicationPlan(map: Stakeholder[]): Record<string, string> {
  return {
    'manage-closely': 'Frequent',
    'keep-satisfied': 'Regular',
    'keep-informed': 'Occasional',
    'monitor': 'Minimal'
  };
}

/**
 * Renders influence/interest matrix in ASCII
 * @param map - Array of stakeholders
 * @returns ASCII matrix string
 */
export function renderMatrix(map: Stakeholder[]): string {
  const matrix: { [key: string]: string[] } = { 'high-high': [], 'high-low': [], 'low-high': [], 'low-low': [] };
  for (const s of map) {
    const q = quadrant(s);
    matrix[q.split('-').join('')].push(s.name);
  }
  return `Influence | High        | Low\n---------|-------------|-------------\nHigh     | ${matrix['high-high'].join(', ')} | ${matrix['high-low'].join(', ')}\nLow      | ${matrix['low-high'].join(', ')} | ${matrix['low-low'].join(', ')}`;
}

/**
 * Exports stakeholder list as CSV
 * @param map - Array of stakeholders
 * @returns CSV string
 */
export function exportCSV(map: Stakeholder[]): string {
  return map.map(s => [
    s.name,
    s.role,
    s.influence.toString(),
    s.interest.toString(),
    s.sentiment.toString(),
    quadrant(s)
  ]).join('\n');
}