/**
 * Approximates the standard normal CDF.
 * @param x - Value to evaluate.
 * @returns CDF value.
 */
function normalCDF(x: number): number {
  const sign = x >= 0 ? 1 : -1;
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const poly = 1.330274429 * t - 1.821255978 * t ** 2 + 1.781477937 * t ** 3 - 0.356563782 * t ** 4 + 0.319381530 * t ** 5;
  const erf = Math.exp(-x * x / 2) * poly;
  return (1 + sign * erf) / 2;
}

/**
 * Approximates the inverse of the standard normal CDF.
 * @param p - Probability.
 * @returns Inverse CDF value.
 */
function inverseNormalCDF(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const q = p < 0.5 ? p : 1 - p;
  const r = Math.sqrt(-2 * Math.log(q));
  const t = 2.506628 * (0.2316419 * r - (0.319381530 * r ** 2 + (-0.356563782 * r ** 3 + (1.781477937 * r ** 4 + (-1.821255978 * r ** 5 + 1.330274429 * r ** 6)))));
  return p < 0.5 ? -t : t;
}

/**
 * Calculates p-value for chi-squared statistic.
 * @param chi2 - Chi-squared value.
 * @param df - Degrees of freedom.
 * @returns Approximate p-value.
 */
function pValue(chi2: number, df: number): number {
  const transformed = (chi2 ** (1/3) - (df / 3 - 1 / 6)) / (Math.sqrt(df) / 3);
  return 1 - normalCDF(transformed);
}

/**
 * Returns critical value for chi-squared test.
 * @param df - Degrees of freedom.
 * @param alpha - Significance level.
 * @returns Critical value.
 */
function criticalValue(df: number, alpha: number): number {
  const z = inverseNormalCDF(1 - alpha);
  return (z * Math.sqrt(df / 9) + (df / 3 - 1 / 6)) ** 3;
}

/**
 * Chi-squared test for goodness of fit.
 * @param observed - Observed frequencies.
 * @param expected - Expected frequencies.
 * @returns Test result.
 */
function goodnessOfFit(observed: number[], expected: number[]): { chi2: number, df: number, pValue: number } {
  let chi2 = 0;
  for (let i = 0; i < observed.length; i++) {
    chi2 += ((observed[i] - expected[i]) ** 2) / expected[i];
  }
  const df = observed.length - 1;
  return { chi2, df, pValue: pValue(chi2, df) };
}

/**
 * Chi-squared test for independence.
 * @param contingencyTable - 2D contingency table.
 * @returns Test result.
 */
function independence(contingencyTable: number[][]): { chi2: number, df: number, pValue: number } {
  const rows = contingencyTable.length;
  const cols = contingencyTable[0].length;
  const grandTotal = contingencyTable.reduce((sum, row) => sum + row.reduce((s, x) => s + x, 0), 0);
  const rowTotals = contingencyTable.map(row => row.reduce((s, x) => s + x, 0));
  const colTotals = Array(cols).fill(0).map((_, j) => 
    rowTotals.reduce((s, rowTotal, i) => s + contingencyTable[i][j], 0)
  );
  let chi2 = 0;
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      const expected = (rowTotals[i] * colTotals[j]) / grandTotal;
      chi2 += ((contingencyTable[i][j] - expected) ** 2) / expected;
    }
  }
  const df = (rows - 1) * (cols - 1);
  return { chi2, df, pValue: pValue(chi2, df) };
}

/**
 * Renders test result as markdown.
 * @param result - Test result.
 * @param testType - Test type.
 * @returns Markdown report.
 */
function renderReport(result: { chi2: number, df: number, pValue: number }, testType: 'goodnessOfFit' | 'independence'): string {
  const p = result.pValue;
  const interpretation = p < 0.05 ? 'Reject the null hypothesis' : 'Fail to reject the null hypothesis';
  return `**Chi-squared Test Result**\n\n- Test Type: ${testType}\n- Chi²: ${result.chi2.toFixed(4)}\n- df: ${result.df}\n- p-value: ${p.toFixed(4)}\n- Interpretation: ${interpretation}`;
}

export { goodnessOfFit, independence, pValue, criticalValue, renderReport };