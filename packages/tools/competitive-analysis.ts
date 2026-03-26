/**
 * Represents a competitor in the analysis.
 */
type Competitor = {
  name: string;
  pricing: string;
  features: string[];
  strengths: string[];
  weaknesses: string[];
};

/**
 * Represents the analysis framework containing competitors.
 */
type Analysis = {
  competitors: Competitor[];
};

/**
 * Adds a competitor to the analysis.
 * @param analysis - The analysis object.
 * @param competitor - The competitor data.
 */
function addCompetitor(analysis: Analysis, competitor: Competitor): void {
  analysis.competitors.push(competitor);
}

/**
 * Compares features across competitors.
 * @param analysis - The analysis object.
 * @returns A feature-vs-competitor boolean grid.
 */
function compareFeatureMatrix(analysis: Analysis): { [feature: string]: { [competitor: string]: boolean } } {
  const allFeatures = new Set<string>();
  analysis.competitors.forEach(c => c.features.forEach(f => allFeatures.add(f)));
  const matrix: { [feature: string]: { [competitor: string]: boolean } } = {};
  allFeatures.forEach(f => {
    matrix[f] = {};
    analysis.competitors.forEach(c => matrix[f][c.name] = c.features.includes(f));
  });
  return matrix;
}

/**
 * Ranks competitors by strength score.
 * @param analysis - The analysis object.
 * @returns Competitors ordered by strength score.
 */
function rankByStrength(analysis: Analysis): Competitor[] {
  return [...analysis.competitors].sort((a, b) => b.strengths.length - a.strengths.length);
}

/**
 * Renders the analysis report in markdown.
 * @param analysis - The analysis object.
 * @returns Markdown report with tables and summary.
 */
function renderReport(analysis: Analysis): string {
  const competitors = analysis.competitors;
  const featureMatrix = compareFeatureMatrix(analysis);
  const ranked = rankByStrength(analysis);

  let report = '# Competitive Analysis Report\n\n## Summary\n\n- Number of competitors: ' + competitors.length + '\n- Top competitor by strength: ' + (ranked[0]?.name || 'N/A') + '\n\n';

  report += '## Features Matrix\n\n| Feature | ' + competitors.map(c => c.name).join(' | ') + ' |\n|-------|' + competitors.map(() => '---').join(' | ') + '|\n';
  for (const [feature, data] of Object.entries(featureMatrix)) {
    report += '| ' + feature + ' | ' + Object.values(data).map(v => v.toString()).join(' | ') + ' |\n';
  }

  report += '\n## Pricing Comparison\n\n| Competitor | Pricing |\n|----------|--------|\n';
  competitors.forEach(c => {
    report += '| ' + c.name + ' | ' + c.pricing + ' |\n';
  });

  report += '\n## Strengths\n\n| Competitor | Strengths |\n|----------|--------|\n';
  competitors.forEach(c => {
    report += '| ' + c.name + ' | ' + c.strengths.join(', ') + ' |\n';
  });

  report += '\n## Weaknesses\n\n| Competitor | Weaknesses |\n|----------|--------|\n';
  competitors.forEach(c => {
    report += '| ' + c.name + ' | ' + c.weaknesses.join(', ') + ' |\n';
  });

  return report;
}

export { addCompetitor, compareFeatureMatrix, rankByStrength, renderReport, Competitor, Analysis };