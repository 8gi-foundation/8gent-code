/**
 * Find root using Newton-Raphson method with automatic numerical derivative.
 * @param f Function to find root of.
 * @param x0 Initial guess.
 * @param tolerance Convergence tolerance.
 * @param maxIter Maximum iterations.
 * @returns Root, iterations, convergence flag.
 */
export function newtonRaphson(f: (x: number) => number, x0: number, tolerance: number = 1e-6, maxIter: number = 100): { root: number; iterations: number; converged: boolean } {
  let x = x0;
  for (let i = 0; i < maxIter; i++) {
    const fx = f(x);
    const dfx = (f(x + 1e-5) - f(x - 1e-5)) / (2e-5);
    if (Math.abs(dfx) < 1e-12) return { root: x, iterations: i, converged: false };
    const nextX = x - fx / dfx;
    if (Math.abs(nextX - x) < tolerance) return { root: nextX, iterations: i + 1, converged: true };
    x = nextX;
  }
  return { root: x, iterations: maxIter, converged: false };
}

/**
 * Find root using bisection method (guaranteed convergence).
 * @param f Function to find root of.
 * @param a Lower bound of interval.
 * @param b Upper bound of interval.
 * @param tolerance Convergence tolerance.
 * @param maxIter Maximum iterations.
 * @returns Root, iterations, convergence flag.
 */
export function bisection(f: (x: number) => number, a: number, b: number, tolerance: number = 1e-6, maxIter: number = 100): { root: number; iterations: number; converged: boolean } {
  let fa = f(a);
  let fb = f(b);
  if (fa * fb >= 0) return { root: NaN, iterations: 0, converged: false };
  for (let i = 0; i < maxIter; i++) {
    const c = (a + b) / 2;
    const fc = f(c);
    if (Math.abs(fc) < tolerance) return { root: c, iterations: i + 1, converged: true };
    if (fa * fc < 0) b = c; else a = c;
    if (Math.abs(b - a) < tolerance) return { root: (a + b) / 2, iterations: i + 1, converged: true };
  }
  return { root: (a + b) / 2, iterations: maxIter, converged: false };
}

/**
 * Find root using secant method (derivative-free).
 * @param f Function to find root of.
 * @param x0 First initial guess.
 * @param x1 Second initial guess.
 * @param tolerance Convergence tolerance.
 * @param maxIter Maximum iterations.
 * @returns Root, iterations, convergence flag.
 */
export function secant(f: (x: number) => number, x0: number, x1: number, tolerance: number = 1e-6, maxIter: number = 100): { root: number; iterations: number; converged: boolean } {
  let xPrev = x0;
  let xCurr = x1;
  let fPrev = f(xPrev);
  let fCurr = f(xCurr);
  for (let i = 0; i < maxIter; i++) {
    if (Math.abs(fCurr) < tolerance) return { root: xCurr, iterations: i + 1, converged: true };
    if (Math.abs(fCurr - fPrev) < 1e-12) return { root: xCurr, iterations: i, converged: false };
    const xNext = xCurr - fCurr * (xCurr - xPrev) / (fCurr - fPrev);
    xPrev = xCurr;
    xCurr = xNext;
    fPrev = fCurr;
    fCurr = f(xCurr);
  }
  return { root: xCurr, iterations: maxIter, converged: false };
}