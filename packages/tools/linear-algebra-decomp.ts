/**
 * Perform LU decomposition with partial pivoting.
 * @param matrix Input matrix.
 * @returns { L: Lower triangular matrix, U: Upper triangular matrix, P: Permutation matrix }
 */
export function lu(matrix: number[][]): { L: number[][], U: number[][], P: number[][] } {
  const n = matrix.length;
  let A = matrix.map(row => [...row]);
  let L = Array(n).fill(0).map(() => Array(n).fill(0));
  let P = Array(n).fill(0).map(() => Array(n).fill(0).map((_, i) => i === 0 ? 1 : 0));
  for (let i = 0; i < n; i++) {
    let maxRow = i;
    for (let j = i; j < n; j++) if (Math.abs(A[j][i]) > Math.abs(A[maxRow][i])) maxRow = j;
    if (maxRow !== i) [A[i], A[maxRow]] = [A[maxRow], A[i]], [P[i], P[maxRow]] = [P[maxRow], P[i]];
    for (let j = i + 1; j < n; j++) {
      L[j][i] = A[j][i] / A[i][i];
      for (let k = i; k < n; k++) A[j][k] -= L[j][i] * A[i][k];
    }
    L[i][i] = 1;
  }
  return { L, U: A, P };
}

/**
 * Solve Ax = b using LU decomposition.
 * @param L Lower triangular matrix.
 * @param U Upper triangular matrix.
 * @param P Permutation matrix.
 * @param b Right-hand side vector.
 * @returns Solution vector.
 */
export function solveLU(L: number[][], U: number[][], P: number[][], b: number[][]): number[][] {
  const n = L.length;
  let y = Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    y[i] = P[i].reduce((s, p, j) => s + p * b[j][0], 0);
    for (let j = 0; j < i; j++) y[i] -= L[i][j] * y[j];
  }
  let x = Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    x[i] = y[i];
    for (let j = i + 1; j < n; j++) x[i] -= U[i][j] * x[j];
    x[i] /= U[i][i];
  }
  return [x];
}

/**
 * Perform QR decomposition via Gram-Schmidt.
 * @param matrix Input matrix.
 * @returns { Q: Orthogonal matrix, R: Upper triangular matrix }
 */
export function qr(matrix: number[][]): { Q: number[][], R: number[][] } {
  const n = matrix.length;
  const m = matrix[0].length;
  let Q = Array(n).fill(0).map(() => Array(n).fill(0));
  let R = Array(n).fill(0).map(() => Array(m).fill(0));
  for (let i = 0; i < m; i++) {
    let v = matrix.map(row => row[i]);
    for (let j = 0; j < i; j++) {
      let dot = Q[j].reduce((s, q, k) => s + q * matrix[k][i], 0);
      for (let k = 0; k < n; k++) v[k] -= Q[j][k] * dot;
    }
    let norm = Math.sqrt(v.reduce((s, val) => s + val * val, 0));
    for (let k = 0; k < n; k++) Q[i][k] = v[k] / norm;
    for (let j = 0; j < n; j++) R[i][i] += matrix[j][i] * Q[i][j];
  }
  return { Q, R };
}

/**
 * Solve Ax = b using QR decomposition.
 * @param Q Orthogonal matrix.
 * @param R Upper triangular matrix.
 * @param b Right-hand side vector.
 * @returns Solution vector.
 */
export function solveQR(Q: number[][], R: number[][], b: number[][]): number[][] {
  const n = Q.length;
  let qTb = Q.map(row => row.reduce((s, q, i) => s + q * b[i][0], 0));
  let x = Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    x[i] = qTb[i];
    for (let j = i + 1; j < n; j++) x[i] -= R[i][j] * x[j];
    x[i] /= R[i][i];
  }
  return [x];
}

/**
 * Perform Cholesky decomposition for symmetric positive-definite matrices.
 * @param matrix Input matrix.
 * @returns Lower triangular matrix L such that A = LL^T.
 */
export function cholesky(matrix: number[][]): number[][] {
  const n = matrix.length;
  let L = Array(n).fill(0).map(() => Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = 0;
      for (let k = 0; k < j; k++) sum += L[i][k] * L[j][k];
      if (i === j) {
        if (matrix[i][i] - sum < 0) throw new Error('Matrix not positive definite');
        L[i][j] = Math.sqrt(matrix[i][i] - sum);
      } else L[i][j] = (matrix[i][j] - sum) / L[j][j];
    }
  }
  return L;
}

/**
 * Solve Ax = b using Cholesky decomposition.
 * @param L Lower triangular matrix.
 * @param b Right-hand side vector.
 * @returns Solution vector.
 */
export function solveCholesky(L: number[][], b: number[][]): number[][] {
  const n = L.length;
  let x = Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    x[i] = b[i][0];
    for (let j = 0; j < i; j++) x[i] -= L[i][j] * x[j];
    x[i] /= L[i][i];
  }
  return [x];
}