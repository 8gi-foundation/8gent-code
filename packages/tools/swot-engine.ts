/**
 * Represents a SWOT analysis with factors categorized into Strengths, Weaknesses, Opportunities, and Threats.
 */
type Swot = Record<'S' | 'W' | 'O' | 'T', { text: string; score: number }[]>;

/**
 * Adds a factor to the SWOT analysis.
 * @param swot - The SWOT analysis object.
 * @param quadrant - The quadrant to add the factor to (S, W, O, T).
 * @param factor - The factor object with text and score.
 * @returns The updated SWOT analysis.
 */
function addFactor(swot: Swot, quadrant: 'S' | 'W' | 'O' | 'T', { text, score }: { text: string; score: number }): Swot {
  if (!swot[quadrant]) {
    swot[quadrant] = [];
  }
  swot[quadrant].push({ text, score });
  return swot;
}

/**
 * Prioritizes factors in each quadrant by score descending.
 * @param swot - The SWOT analysis object.
 * @returns A new SWOT analysis with factors sorted by score.
 */
function prioritize(swot: Swot): Swot {
  return {
    S: [...swot.S].sort((a, b) => b.score - a.score),
    W: [...swot.W].sort((a, b) => b.score - a.score),
    O: [...swot.O].sort((a, b) => b.score - a.score),
    T: [...swot.T].sort((a, b) => b.score - a.score),
  };
}

/**
 * Generates strategy pairs (SO, ST, WO, WT) based on prioritized factors.
 * @param swot - The SWOT analysis object.
 * @returns An array of strategy strings.
 */
function generateStrategies(swot: Swot): string[] {
  const strategies: string[] = [];
  const { S, W, O, T } = swot;

  const so = S.slice(0, 1).flatMap(s => O.slice(0, 1).map(o => `SO: ${s.text} -> ${o.text}`));
  const st = S.slice(0, 1).flatMap(s => T.slice(0, 1).map(t => `ST: ${s.text} -> ${t.text}`));
  const wo = W.slice(0, 1).flatMap(w => O.slice(0, 1).map(o => `WO: ${w.text} -> ${o.text}`));
  const wt = W.slice(0, 1).flatMap(w => T.slice(0, 1).map(t => `WT: ${w.text} -> ${t.text}`));

  return [...so, ...st, ...wo, ...wt];
}

/**
 * Renders the SWOT analysis as a Markdown document.
 * @param swot - The SWOT analysis object.
 * @returns The Markdown content as a string.
 */
function renderMarkdown(swot: Swot): string {
  const prioritized = prioritize(swot);
  let markdown = '# SWOT Analysis\n\n';

  const quadrants: { key: 'S' | 'W' | 'O' | 'T'; label: string }[] = [
    { key: 'S', label: 'Strengths' },
    { key: 'W', label: 'Weaknesses' },
    { key: 'O', label: 'Opportunities' },
    { key: 'T', label: 'Threats' },
  ];

  for (const { key, label } of quadrants) {
    markdown += `## ${label}\n`;
    markdown += prioritized[key]
      .map((factor, index) => `${index + 1}. **${factor.text}** (Score: ${factor.score})`)
      .join('\n') + '\n';
  }

  const strategies = generateStrategies(prioritized);
  markdown += '## Strategies\n';
  markdown += strategies.join('\n') + '\n';

  return markdown;
}

export { addFactor, prioritize, generateStrategies, renderMarkdown };