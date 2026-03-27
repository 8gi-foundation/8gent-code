/**
 * Numerically integrates a function over [a, b] using the trapezoidal rule.
 * @param f - Function to integrate
 * @param a - Lower integration limit
 * @param b - Upper integration limit
 * @param nPoints - Number of intervals (default: 1000)
 * @returns Integral value
 */
export function integrate(
  f: (x: number) => number,
  a: number,
  b: number,
  nPoints: number = 1000
): number {
  const dx = (b - a) / nPoints
  let sum = f(a) + f(b)
  for (let i = 1; i < nPoints; i++) {
    sum += 2 * f(a + i * dx)
  }
  return sum * dx / 2
}

/**
 * Computes Fourier series coefficients for a periodic function.
 * @param f - Function to analyze
 * @param period - Period of the function
 * @param nHarmonics - Number of harmonics to compute
 * @returns Object containing a0, a_n, and b_n coefficients
 */
export function computeFourierCoefficients(
  f: (x: number) => number,
  period: number,
  nHarmonics: number
): { a0: number; a: number[]; b: number[] } {
  const a: number[] = []
  const b: number[] = []
  const T = period
  const a0 = (1 / T) * integrate(f, 0, T)
  for (let n = 1; n <= nHarmonics; n++) {
    const cosTerm = (x: number) => Math.cos(2 * Math.PI * n * x / T)
    const sinTerm = (x: number) => Math.sin(2 * Math.PI * n * x / T)
    a.push((2 / T) * integrate(x => f(x) * cosTerm(x), 0, T))
    b.push((2 / T) * integrate(x => f(x) * sinTerm(x), 0, T))
  }
  return { a0, a, b }
}

/**
 * Reconstructs a function from its Fourier coefficients.
 * @param x - Point at which to evaluate reconstruction
 * @param period - Period of the original function
 * @param a0 - DC coefficient
 * @param a - Array of cosine coefficients
 * @param b - Array of sine coefficients
 * @returns Reconstructed function value at x
 */
export function reconstructFunction(
  x: number,
  period: number,
  a0: number,
  a: number[],
  b: number[]
): number {
  let result = a0 / 2
  for (let n = 0; n < a.length; n++) {
    const term = a[n] * Math.cos(2 * Math.PI * (n + 1) * x / period) + b[n] * Math.sin(2 * Math.PI * (n + 1) * x / period)
    result += term
  }
  return result
}

/**
 * Computes mean squared error between original and reconstructed function.
 * @param f - Original function
 * @param period - Period of the function
 * @param a0 - DC coefficient
 * @param a - Array of cosine coefficients
 * @param b - Array of sine coefficients
 * @param nSamples - Number of samples to use (default: 1000)
 * @returns Mean squared error
 */
export function meanSquaredError(
  f: (x: number) => number,
  period: number,
  a0: number,
  a: number[],
  b: number[],
  nSamples: number = 1000
): number {
  const dx = period / nSamples
  let sum = 0
  for (let i = 0; i < nSamples; i++) {
    const x = i * dx
    const fx = f(x)
    const rx = reconstructFunction(x, period, a0, a, b)
    sum += Math.pow(fx - rx, 2)
  }
  return sum / nSamples
}