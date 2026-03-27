/**
 * Confusion matrix with labels and counts.
 */
interface ConfusionMatrix {
  matrix: number[][];
  labels: string[];
}

/**
 * Build confusion matrix from actual and predicted labels.
 * @param actuals - Array of true labels
 * @param predictions - Array of predicted labels
 * @returns Confusion matrix object
 */
function build(actuals: string[], predictions: string[]): ConfusionMatrix {
  const allLabels = [...new Set([...actuals, ...predictions])];
  const sortedLabels = allLabels.sort();
  const n = sortedLabels.length;
  const matrix = Array(n).fill(0).map(() => Array(n).fill(0));
  
  for (let i = 0; i < actuals.length; i++) {
    const actual = actuals[i];
    const predicted = predictions[i];
    const actualIdx = sortedLabels.indexOf(actual);
    const predictedIdx = sortedLabels.indexOf(predicted);
    if (actualIdx !== -1 && predictedIdx !== -1) {
      matrix[actualIdx][predictedIdx]++;
    }
  }
  
  return { matrix, labels: sortedLabels };
}

/**
 * Calculate overall accuracy from confusion matrix.
 * @param cm - Confusion matrix
 * @returns Accuracy as a number between 0 and 1
 */
function accuracy(cm: ConfusionMatrix): number {
  const total = cm.matrix.flat().reduce((sum, x) => sum + x, 0);
  const correct = cm.matrix.reduce((sum, row, i) => sum + row[i], 0);
  return total === 0 ? 0 : correct / total;
}

/**
 * Calculate precision for a class or macro-averaged precision.
 * @param cm - Confusion matrix
 * @param label - Optional class label
 * @returns Precision value
 */
function precision(cm: ConfusionMatrix, label?: string): number {
  if (!label) {
    const ps = cm.labels.map(l => precision(cm, l));
    return ps.reduce((sum, p) => sum + p, 0) / ps.length;
  }
  
  const idx = cm.labels.indexOf(label);
  if (idx === -1) return 0;
  
  const tp = cm.matrix[idx][idx];
  const fp = cm.matrix[idx].reduce((sum, val, j) => sum + (j === idx ? 0 : val), 0);
  const denom = tp + fp;
  return denom === 0 ? 0 : tp / denom;
}

/**
 * Calculate recall for a class or macro-averaged recall.
 * @param cm - Confusion matrix
 * @param label - Optional class label
 * @returns Recall value
 */
function recall(cm: ConfusionMatrix, label?: string): number {
  if (!label) {
    const rs = cm.labels.map(l => recall(cm, l));
    return rs.reduce((sum, r) => sum + r, 0) / rs.length;
  }
  
  const idx = cm.labels.indexOf(label);
  if (idx === -1) return 0;
  
  const tp = cm.matrix[idx][idx];
  const fn = cm.matrix.reduce((sum, row, i) => sum + (i === idx ? 0 : row[idx]), 0);
  const denom = tp + fn;
  return denom === 0 ? 0 : tp / denom;
}

/**
 * Calculate F1 score for a class or macro-averaged F1.
 * @param cm - Confusion matrix
 * @param label - Optional class label
 * @returns F1 score
 */
function f1(cm: ConfusionMatrix, label?: string): number {
  if (!label) {
    const f1s = cm.labels.map(l => f1(cm, l));
    return f1s.reduce((sum, f) => sum + f, 0) / f1s.length;
  }
  
  const p = precision(cm, label);
  const r = recall(cm, label);
  return (p + r) === 0 ? 0 : 2 * p * r / (p + r);
}

/**
 * Render confusion matrix as ASCII table.
 * @param cm - Confusion matrix
 * @returns ASCII representation of matrix
 */
function renderMatrix(cm: ConfusionMatrix): string {
  const labels = cm.labels;
  const matrix = cm.matrix;
  const header = 'Predicted'.padEnd(10) + labels.join(' ');
  const separator = ' '.repeat(10) + '-'.repeat(labels.length * 2 - 1);
  
  const rows = labels.map((label, i) => {
    const row = matrix[i].join(' ');
    return `${label.padEnd(10)}| ${row}`;
  });
  
  return `${header}\n${separator}\n${rows.join('\n')}`;
}

export { ConfusionMatrix, build, accuracy, precision, recall, f1, renderMatrix };