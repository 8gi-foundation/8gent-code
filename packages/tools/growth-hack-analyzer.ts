/**
 * Growth experiment interface
 */
interface Experiment {
  name: string;
  impact: number;
  confidence: number;
  ease: number;
  owner: string;
}

/**
 * Adds an experiment to the backlog
 * @param backlog - Current list of experiments
 * @param experiment - New experiment details
 * @returns Updated backlog
 */
function addExperiment(backlog: Experiment[], experiment: { name: string; impact: number; confidence: number; ease: number; owner: string }): Experiment[] {
  return [...backlog, { ...experiment }];
}

/**
 * Calculates ICE score for an experiment
 * @param experiment - Experiment to score
 * @returns ICE score (impact + confidence + ease) / 3
 */
function iceScore(experiment: Experiment): number {
  return (experiment.impact + experiment.confidence + experiment.ease) / 3;
}

/**
 * Prioritizes experiments by ICE score descending
 * @param backlog - List of experiments
 * @returns Sorted list
 */
function prioritize(backlog: Experiment[]): Experiment[] {
  return [...backlog].sort((a, b) => iceScore(b) - iceScore(a));
}

/**
 * Renders roadmap as markdown table
 * @param backlog - List of experiments
 * @returns Markdown table
 */
function renderRoadmap(backlog: Experiment[]): string {
  const header = '| Name | Owner | Impact | Confidence | Ease | ICE Score |\n|---|---|---|---|---|---|';
  const rows = backlog.map(exp => 
    `| ${exp.name} | ${exp.owner} | ${exp.impact} | ${exp.confidence} | ${exp.ease} | ${iceScore(exp).toFixed(2)} |`
  );
  return [header, ...rows].join('\n');
}

export { addExperiment, iceScore, prioritize, renderRoadmap };