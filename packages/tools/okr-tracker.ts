/**
 * OKR Tracker utility
 */
export class OKRTracker {
  private objectives: Map<string, Objective> = new Map();

  /**
   * Add an objective to the tracker
   * @param {Object} params - Objective parameters
   * @param {string} params.title - Objective title
   * @param {string} params.quarter - Quarter (e.g. "Q3 2023")
   * @returns {string} Objective ID
   */
  addObjective({ title, quarter }: { title: string; quarter: string }): string {
    const id = `OBJ-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;
    this.objectives.set(id, { id, title, quarter, keyResults: [] });
    return id;
  }

  /**
   * Add a key result to an objective
   * @param {string} objectiveId - Target objective ID
   * @param {Object} params - Key result parameters
   * @param {string} params.title - Key result title
   * @param {number} params.target - Target value
   * @param {number} params.current - Current value
   * @param {string} params.unit - Unit of measurement
   */
  addKeyResult(
    objectiveId: string,
    { title, target, current, unit }: { title: string; target: number; current: number; unit: string }
  ): void {
    const objective = this.objectives.get(objectiveId);
    if (!objective) return;

    objective.keyResults.push({ title, target, current, unit });
  }

  /**
   * Calculate key result score (0.0-1.0)
   * @param {KeyResult} kr - Key result object
   * @returns {number} Score between 0.0 and 1.0
   */
  score(kr: KeyResult): number {
    if (kr.target === 0) return 0;
    const ratio = kr.current / kr.target;
    return Math.min(1, Math.max(0, ratio));
  }

  /**
   * Calculate objective score (average of key result scores)
   * @param {Objective} objective - Objective object
   * @returns {number} Score between 0.0 and 1.0
   */
  objectiveScore(objective: Objective): number {
    if (objective.keyResults.length === 0) return 0;
    const scores = objective.keyResults.map(kr => this.score(kr));
    return scores.reduce((a, b) => a + b, 0) / scores.length;
  }

  /**
   * Generate markdown OKR report
   * @returns {string} Markdown report with scores and RAG status
   */
  renderReport(): string {
    let report = '# OKR Report\n\n';
    
    for (const [id, objective] of this.objectives.entries()) {
      const score = this.objectiveScore(objective);
      const rag = score >= 0.7 ? '🟢 Green' : score >= 0.3 ? '🟡 Amber' : '🔴 Red';
      
      report += `## ${objective.title} (${objective.quarter}) - ${rag}\n\n`;
      report += `**Score**: ${score.toFixed(2)}\n\n`;
      
      for (const kr of objective.keyResults) {
        const krScore = this.score(kr);
        const krRag = krScore >= 0.7 ? '🟢' : krScore >= 0.3 ? '🟡' : '🔴';
        
        report += `- ${kr.title} (${kr.unit})\n`;
        report += `  - Target: ${kr.target}\n`;
        report += `  - Current: ${kr.current}\n`;
        report += `  - Score: ${krScore.toFixed(2)} ${krRag}\n\n`;
      }
    }
    
    return report;
  }
}

/**
 * Objective interface
 */
interface Objective {
  id: string;
  title: string;
  quarter: string;
  keyResults: KeyResult[];
}

/**
 * KeyResult interface
 */
interface KeyResult {
  title: string;
  target: number;
  current: number;
  unit: string;
}