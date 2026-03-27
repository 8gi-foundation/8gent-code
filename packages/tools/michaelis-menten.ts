/**
 * Perform linear regression on x and y data.
 * @param x - Array of x values.
 * @param y - Array of y values.
 * @returns Object with slope and intercept.
 */
function linearRegression(x: number[], y: number[]): { slope: number; intercept: number } {
  const n = x.length;
  const sumX = x.reduce((a, b) => a + b, 0);
  const sumY = y.reduce((a, b) => a + b, 0);
  const sumXY = x.reduce((a, b, i) => a + b * y[i], 0);
  const sumX2 = x.reduce((a, b) => a + b * b, 0);
  const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
  const intercept = (sumY - slope * sumX) / n;
  return { slope, intercept };
}

/**
 * Fit enzyme kinetics data to Michaelis-Menten model using Lineweaver-Burk linearization.
 * @param substrate - Substrate concentrations.
 * @param velocity - Reaction velocities.
 * @param eTotal - Total enzyme concentration.
 * @returns Object with Km, Vmax, and catalytic efficiency (kcat/Km).
 */
export function fitMichaelisMenten(substrate: number[], velocity: number[], eTotal: number): { Km: number; Vmax: number; catalyticEfficiency: number } {
  const x = substrate.map(s => 1 / s);
  const y = velocity.map(v => 1 / v);
  const { slope, intercept } = linearRegression(x, y);
  const Km = slope / intercept;
  const Vmax = 1 / intercept;
  const kcat = Vmax / eTotal;
  return { Km, Vmax, catalyticEfficiency: kcat / Km };
}