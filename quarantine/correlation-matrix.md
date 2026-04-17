# correlation-matrix

Pearson and Spearman correlation matrix builder for multivariate datasets.

## Requirements
- pearson(xs, ys): correlation coefficient between two series
- spearman(xs, ys): rank-based correlation
- matrix(data{}, method?): n x n correlation matrix for all column pairs
- strongestPairs(matrix, threshold): returns pairs with |r| > threshold
- renderMatrix(matrix): ASCII correlation matrix with values

## Status

Quarantine - pending review.

## Location

`packages/tools/correlation-matrix.ts`
