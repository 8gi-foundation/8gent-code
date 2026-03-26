interface Deal {
  name: string;
  value: number;
  stage: string;
  closeDate: Date;
  history: Array<{ from: string; to: string; at: Date }>;
}

const PROBABILITY: { [key: string]: number } = {
  'Qualification': 0.1,
  'Proposal': 0.3,
  'Negotiation': 0.6,
  'Closed Won': 1.0,
  'Closed Lost': 0.0
};

/**
 * Adds a new deal to the pipeline.
 * @param pipeline - The pipeline array.
 * @param deal - Deal details.
 */
function addDeal(pipeline: Deal[], { name, value, stage, closeDate }: { name: string; value: number; stage: string; closeDate: Date }): void {
  pipeline.push({
    name,
    value,
    stage,
    closeDate,
    history: []
  });
}

/**
 * Moves a deal to a new stage and records the transition.
 * @param deal - The deal to move.
 * @param newStage - The new stage.
 */
function moveStage(deal: Deal, newStage: string): void {
  const historyEntry = {
    from: deal.stage,
    to: newStage,
    at: new Date()
  };
  deal.history.push(historyEntry);
  deal.stage = newStage;
}

/**
 * Calculates the weighted forecast for the pipeline.
 * @param pipeline - The pipeline array.
 * @returns Total weighted forecast.
 */
function forecast(pipeline: Deal[]): number {
  return pipeline.reduce((sum, deal) => {
    const prob = PROBABILITY[deal.stage] || 0;
    return sum + deal.value * prob;
  }, 0);
}

/**
 * Calculates the conversion rate between two stages.
 * @param pipeline - The pipeline array.
 * @param fromStage - The source stage.
 * @param toStage - The target stage.
 * @returns Conversion percentage.
 */
function stageConversionRate(pipeline: Deal[], fromStage: string, toStage: string): number {
  let total = 0;
  let success = 0;
  for (const deal of pipeline) {
    for (const entry of deal.history) {
      if (entry.from === fromStage && entry.to === toStage) {
        success++;
      }
      if (entry.from === fromStage) {
        total++;
      }
    }
  }
  return total === 0 ? 0 : success / total;
}

/**
 * Renders the sales funnel as ASCII art.
 * @param pipeline - The pipeline array.
 * @returns ASCII funnel representation.
 */
function renderFunnel(pipeline: Deal[]): string {
  const stages: { [key: string]: { count: number; value: number } } = {};
  for (const deal of pipeline) {
    const stage = deal.stage;
    if (!stages[stage]) {
      stages[stage] = { count: 0, value: 0 };
    }
    stages[stage].count++;
    stages[stage].value += deal.value;
  }

  const sortedStages = Object.keys(stages).sort((a, b) => PROBABILITY[b] - PROBABILITY[a]);

  const funnel: string[] = [];
  for (const stage of sortedStages) {
    const data = stages[stage];
    const line = `${stage.padEnd(15)} ${data.count} deals | $${data.value.toFixed(2)}`;
    funnel.push(line);
  }

  const maxCount = Math.max(...Object.values(stages).map(s => s.count));
  const maxVal = Math.max(...Object.values(stages).map(s => s.value));
  const visualization = sortedStages.map(stage => {
    const data = stages[stage];
    const countRatio = data.count / maxCount;
    const bar = '>'.padEnd(Math.floor(countRatio * 20) + 1, '-');
    return `${bar} ${Math.floor(countRatio * 100)}% (${data.count})`;
  }).join('\n');

  return visualization + '\n\n' + funnel.join('\n');
}