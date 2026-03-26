type Stage = {
  name: string;
  touchpoints: string[];
  emotion: number;
  painPoints: string[];
  opportunities: string[];
};

type Journey = {
  stages: Stage[];
};

/**
 * Adds a stage to the journey.
 * @param journey - The journey object.
 * @param stage - The stage configuration.
 */
function addStage(journey: Journey, stage: Stage): void {
  journey.stages.push(stage);
}

/**
 * Identifies stages with no opportunities.
 * @param journey - The journey object.
 * @returns Array of stages with no opportunities.
 */
function identifyGaps(journey: Journey): Stage[] {
  return journey.stages.filter(stage => stage.opportunities.length === 0);
}

/**
 * Renders the journey timeline as ASCII art.
 * @param journey - The journey object.
 * @returns ASCII timeline string.
 */
function renderTimeline(journey: Journey): string {
  return journey.stages
    .map((stage, index) => {
      const name = stage.name || `Stage ${index + 1}`;
      return `${name.padEnd(15)}${'='.repeat(20 - name.length)}`;
    })
    .join('\n');
}

/**
 * Exports the journey as a JSON object.
 * @param journey - The journey object.
 * @returns Serializable JSON structure.
 */
function exportJSON(journey: Journey): object {
  return journey;
}

/**
 * Scores the overall experience based on emotion.
 * @param journey - The journey object.
 * @returns Average emotion score.
 */
function scoreExperience(journey: Journey): number {
  if (journey.stages.length === 0) return 0;
  const total = journey.stages.reduce((sum, stage) => sum + stage.emotion, 0);
  return total / journey.stages.length;
}

export { addStage, identifyGaps, renderTimeline, exportJSON, scoreExperience };