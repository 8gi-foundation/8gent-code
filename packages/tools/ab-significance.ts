/**
 * Calculate z-score and p-value for A/B test comparison.
 * @param controlConversions - Number of conversions in control group
 * @param controlTotal - Total number of users in control group
 * @param treatmentConversions - Number of conversions in treatment group
 * @param treatmentTotal - Total number of users in treatment group
 * @returns Object with z-score, p-value, and significance
 */
function zTest(
  controlConversions: number,
  controlTotal: number,
  treatmentConversions: number,
  treatmentTotal: number
): { zScore: number; pValue: number; significant: boolean } {
  const pControl = controlConversions / controlTotal;
  const pTreatment = treatmentConversions / treatmentTotal;
  const pPool = (controlConversions + treatmentConversions) / (controlTotal + treatmentTotal);
  const se = Math.sqrt(pPool * (1 - pPool) * (1 / controlTotal + 1 / treatmentTotal));
  const zScore = (pTreatment - pControl) / se;
  const pValue = 2 * (1 - normalCDF(Math.abs(zScore)));
  const significant = pValue < 0.05;
  return { zScore, pValue, significant };
}

/**
 * Calculate chi-squared statistic and p-value for contingency table.
 * @param contingencyTable - 2x2 array of observed frequencies
 * @returns Object with chi-squared statistic and p-value
 */
function chiSquared(contingencyTable: number[][]): { statistic: number; pValue: number } {
  const [[a, b], [c, d]] = contingencyTable;
  const total = a + b + c + d;
  const expectedA = (a + c) * (a + b) / total;
  const expectedB = (a + b) * (b + d) / total;
  const expectedC = (c + d) * (a + c) / total;
  const expectedD = (b + d) * (c + d) / total;
  const statistic = (
    ((a - expectedA) ** 2) / expectedA +
    ((b - expectedB) ** 2) / expectedB +
    ((c - expectedC) ** 2) / expectedC +
    ((d - expectedD) ** 2) / expectedD
  );
  const pValue = 1 - normalCDF(Math.sqrt(statistic));
  return { statistic, pValue };
}

/**
 * Calculate minimum required sample size for A/B test.
 * @param baseRate - Baseline conversion rate
 * @param mde - Minimum detectable effect
 * @param alpha - Significance level (default 0.05)
 * @param power - Statistical power (default 0.8)
 * @returns Required sample size per group
 */
function requiredSampleSize(
  baseRate: number,
  mde: number,
  alpha: number = 0.05,
  power: number = 0.8
): number {
  const zAlpha = 1.96; // for alpha=0.05
  const zBeta = 1.28; // for power=0.8
  const p0 = baseRate;
  const p1 = p0 + mde;
  const numerator = (zAlpha + zBeta) ** 2 * (p0 * (1 - p0) + p1 * (1 - p1));
  const denominator = (p1 - p0) ** 2;
  const sampleSizePerGroup = numerator / denominator;
  return Math.ceil(sampleSizePerGroup * 2);
}

/**
 * Generate markdown report from test results.
 * @param result - Result object from zTest or chiSquared
 * @returns Markdown formatted report
 */
function renderReport(result: { zScore?: number; pValue?: number; significant?: boolean; statistic?: number }): string {
  return `# A/B Test Report

**Z-Score**: ${result.zScore ?? 'N/A'}
**P-Value**: ${result.pValue ?? 'N/A'}
**Significant**: ${result.significant ?? false ? 'Yes' : 'No'}
**Chi-Squared Statistic**: ${result.statistic ?? 'N/A'}

Conclusion: ${result.significant ?? false ? 'The treatment is statistically significant.' : 'No significant difference found.'}`;
}

/**
 * Error function approximation for normal distribution calculations.
 * @param x - Input value
 * @returns Approximated error function value
 */
function erf(x: number): number {
  const a1 =  0.319381530;
  const a2 = -0.356563782;
  const a3 =  1.781477937;
  const a4 = -1.821255978;
  const a5 =  1.330274429;
  const p = 0.3275911;
  const t = 1 / (1 + p * Math.abs(x));
  const poly = t * (a1 + t * (a2 + t * (a3 + t * (a4 + t * a5))));
  const sign = x >= 0 ? 1 : -1;
  return sign * poly;
}

/**
 * Cumulative distribution function for standard normal distribution.
 * @param x - Input value
 * @returns CDF value
 */
function normalCDF(x: number): number {
  return (1 + erf(x / Math.sqrt(2))) / 2;
}