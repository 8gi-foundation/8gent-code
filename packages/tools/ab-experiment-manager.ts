/**
 * A/B experiment lifecycle manager
 */
export class Experiment {
  /** Experiment name */
  name: string;
  /** Variant names */
  variants: string[];
  /** Metric to track */
  metric: string;
  /** User results tracking */
  private results: Map<string, { variant: string; value: number }>;

  /**
   * Create a new experiment
   * @param name - Experiment name
   * @param variants - Array of variant names
   * @param metric - Metric to track
   */
  constructor(name: string, variants: string[], metric: string) {
    this.name = name;
    this.variants = variants;
    this.metric = metric;
    this.results = new Map();
  }

  /**
   * Assign user to variant deterministically
   * @param userId - User identifier
   * @returns Assigned variant name
   */
  assignVariant(userId: string): string {
    const hash = this.hash(userId);
    const index = hash % this.variants.length;
    return this.variants[index];
  }

  /**
   * Record a metric result for a user
   * @param userId - User identifier
   * @param value - Metric value
   */
  recordResult(userId: string, value: number): void {
    const variant = this.assignVariant(userId);
    this.results.set(userId, { variant, value });
  }

  /**
   * Analyze experiment results
   * @returns Analysis results per variant
   */
  analyze(): { [variant: string]: { confidence: number; uplift: number; sampleSize: number } } {
    const variantStats: { [variant: string]: { sum: number; count: number } } = {};
    this.variants.forEach(variant => {
      variantStats[variant] = { sum: 0, count: 0 };
    });

    for (const [userId, { variant, value }] of this.results.entries()) {
      variantStats[variant].sum += value;
      variantStats[variant].count += 1;
    }

    const means = Object.entries(variantStats).reduce((acc, [variant, { sum, count }]) => {
      acc[variant] = sum / count;
      return acc;
    }, {} as { [variant: string]: number });

    const control = this.variants[0];
    const winner = Object.entries(means).reduce((best, [variant, mean]) => {
      return mean > means[best] ? variant : best;
    }, control);

    return this.variants.reduce((acc, variant) => {
      acc[variant] = {
        confidence: means[variant],
        uplift: variant === winner ? ((means[variant] - means[control]) / means[control]) * 100 : 0,
        sampleSize: variantStats[variant].count
      };
      return acc;
    }, {} as { [variant: string]: { confidence: number; uplift: number; sampleSize: number } });
  }

  /**
   * Render markdown report
   * @returns Markdown experiment report
   */
  renderReport(): string {
    const analysis = this.analyze();
    const headers = ['Variant', 'Confidence', 'Uplift (%)', 'Sample Size'];
    const rows = this.variants.map(variant => [
      variant,
      analysis[variant].confidence.toFixed(2),
      analysis[variant].uplift.toFixed(2),
      analysis[variant].sampleSize.toString()
    ]);
    return `# ${this.name} Report\n\n**Metric:** ${this.metric}\n\n| ${headers.join(' | ')} |\n|---|---|---|---|\n| ${rows.map(row => row.join(' | ')).join(' |\n| ')} |`;
  }

  /**
   * Simple hash function for deterministic assignment
   * @param str - String to hash
   * @returns Hash value
   */
  private hash(str: string): number {
    return Array.from(str).reduce((acc, char) => acc + char.charCodeAt(0), 0);
  }
}

/**
 * Create a new experiment
 * @param name - Experiment name
 * @param options - Configuration options
 * @returns Experiment instance
 */
export function createExperiment(name: string, options: { variants: string[]; metric: string }): Experiment {
  return new Experiment(name, options.variants, options.metric);
}

/**
 * Assign user to variant
 * @param experiment - Experiment instance
 * @param userId - User identifier
 * @returns Assigned variant name
 */
export function assignVariant(experiment: Experiment, userId: string): string {
  return experiment.assignVariant(userId);
}

/**
 * Record a result for a user
 * @param experiment - Experiment instance
 * @param userId - User identifier
 * @param value - Metric value
 */
export function recordResult(experiment: Experiment, userId: string, value: number): void {
  experiment.recordResult(userId, value);
}

/**
 * Analyze experiment results
 * @param experiment - Experiment instance
 * @returns Analysis results per variant
 */
export function analyze(experiment: Experiment): { [variant: string]: { confidence: number; uplift: number; sampleSize: number } } {
  return experiment.analyze();
}

/**
 * Render markdown report
 * @param experiment - Experiment instance
 * @returns Markdown experiment report
 */
export function renderReport(experiment: Experiment): string {
  return experiment.renderReport();
}