/**
 * Numerically integrate using Simpson's 1/3 rule with error estimate.
 * @param f Function to integrate
 * @param a Lower limit
 * @param b Upper limit
 * @param n Number of intervals (must be even)
 * @returns Integral and error estimate
 */
function simpsonsRule(f: (x: number) => number, a: number, b: number, n: number): { integral: number; error: number } {
    const integralN = simpsonsRuleIntegral(f, a, b, n);
    const integral2N = simpsonsRuleIntegral(f, a, b, 2 * n);
    const error = Math.abs(integral2N - integralN) / 15;
    return { integral: integral2N, error };
}

/**
 * Helper for Simpson's rule.
 */
function simpsonsRuleIntegral(f: (x: number) => number, a: number, b: number, n: number): number {
    if (n % 2 !== 0) throw new Error("n must be even");
    const h = (b - a) / n;
    let sum = 0;
    for (let i = 1; i < n; i++) {
        const x = a + i * h;
        sum += (i % 2 === 0 ? 2 : 4) * f(x);
    }
    sum += f(a) + f(b);
    return (h / 3) * sum;
}

/**
 * 5-point Gaussian-Legendre quadrature.
 * @param f Function to integrate
 * @param a Lower limit
 * @param b Upper limit
 * @returns Integral estimate
 */
function gaussianQuadrature(f: (x: number) => number, a: number, b: number): number {
    const nodes = [0.9061798459, 0.5384693101, 0.0, -0.5384693101, -0.9061798459];
    const weights = [0.2369268850, 0.4786286705, 0.5688888889, 0.4786286705, 0.2369268850];
    let integral = 0;
    for (let i = 0; i < 5; i++) {
        const x = (b - a) / 2 * nodes[i] + (a + b) / 2;
        integral += weights[i] * f(x);
    }
    return integral * (b - a) / 2;
}

/**
 * Monte Carlo integration with confidence interval.
 * @param f Function to integrate
 * @param a Lower limit
 * @param b Upper limit
 * @param samples Number of samples
 * @param confidence Z-score for confidence interval (default 1.96)
 * @returns Mean and confidence interval
 */
function monteCarloIntegrate(f: (x: number) => number, a: number, b: number, samples: number, confidence: number = 1.96): { mean: number; lower: number; upper: number } {
    const values = new Array(samples).fill(0).map(() => {
        const x = a + Math.random() * (b - a);
        return f(x);
    });
    const mean = values.reduce((s, v) => s + v, 0) / samples;
    const stdDev = Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / (samples - 1));
    const margin = confidence * stdDev / Math.sqrt(samples);
    return { mean, lower: mean - margin, upper: mean + margin };
}

export { simpsonsRule, gaussianQuadrature, monteCarloIntegrate };