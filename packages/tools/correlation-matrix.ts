/**
 * Calculate Pearson correlation coefficient between two series.
 * @param xs - First data series.
 * @param ys - Second data series.
 * @returns Pearson correlation coefficient.
 */
function pearson(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n !== ys.length) throw new Error("Arrays must be of equal length");
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  const cov = xs.reduce((a, x, i) => a + (x - meanX) * (ys[i] - meanY), 0) / (n - 1);
  const stdX = Math.sqrt(xs.reduce((a, x) => a + (x - meanX) ** 2, 0) / (n - 1));
  const stdY = Math.sqrt(ys.reduce((a, y) => a + (y - meanY) ** 2, 0) / (n - 1));
  return cov / (stdX * stdY);
}

/**
 * Calculate Spearman rank correlation coefficient between two series.
 * @param xs - First data series.
 * @param ys - Second data series.
 * @returns Spearman correlation coefficient.
 */
function spearman(xs: number[], ys: number[]): number {
  const rank = (arr: number[]): number[] => {
    const sorted = [...arr].sort((a, b) => a - b);
    const ranks: number[] = new Array(arr.length);
    for (let i = 0; i < arr.length; i++) {
      let count = 0;
      for (let j = 0; j < arr.length; j++) {
        if (arr[i] === sorted[j]) count++;
      }
      let pos = 0;
      for (let j = 0; j < sorted.length; j++) {
        if (sorted[j] === arr[i]) {
          pos += j;
          break;
        }
      }
      ranks[i] = (pos + 1) / count;
    }
    return ranks;
  };
  const rx = rank(xs);
  const ry = rank(ys);
  return pearson(rx, ry);
}

/**
 * Generate correlation matrix for multivariate dataset.
 * @param data - Dataset with column names as keys and arrays as values.
 * @param method - Correlation method (pearson or spearman).
 * @returns n x n correlation matrix.
 */
function matrix(data: Record<string, number[]>, method: 'pearson' | 'spearman' = 'pearson'): number[][] {
  const cols = Object.keys(data);
  const n = cols.length;
  const result: number[][] = new Array(n).fill(0).map(() => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const x = data[cols[i]];
      const y = data[cols[j]];
      result[i][j] = method === 'pearson' ? pearson(x, y) : spearman(x, y);
    }
  }
  return result;
}

/**
 * Find strongest correlations above threshold.
 * @param matrix - Correlation matrix.
 * @param threshold - Correlation threshold.
 * @returns Array of [column1, column2, value] with |r| > threshold.
 */
function strongestPairs(matrix: number[][], threshold: number): [string, string, number][] {
  const pairs: [string, string, number][] = [];
  const cols = Object.keys(matrix[0]);
  for (let i = 0; i < matrix.length; i++) {
    for (let j = 0; j < matrix[i].length; j++) {
      if (i !== j && Math.abs(matrix[i][j]) > threshold) {
        pairs.push([cols[i], cols[j], matrix[i][j]]);
      }
    }
  }
  return pairs;
}

/**
 * Render correlation matrix as ASCII table.
 * @param matrix - Correlation matrix.
 * @param labels - Column labels.
 * @returns ASCII representation of matrix.
 */
function renderMatrix(matrix: number[][], labels: string[]): string {
  const rows = [];
  rows.push(`| ${labels.map(l => l.padEnd(8)).join('')} |`);
  for (let i = 0; i < matrix.length; i++) {
    const row = [labels[i].padEnd(8)];
    for (let j = 0; j < matrix[i].length; j++) {
      row.push(matrix[i][j].toFixed(2).padStart(6));
    }
    rows.push(`| ${row.join('')} |`);
  }
  return rows.join('\n');
}

export { pearson, spearman, matrix, strongestPairs, renderMatrix };