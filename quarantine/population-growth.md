# population-growth

Model exponential and logistic population growth with time-series output.

## Requirements
- Exponential: N(t) = N0 * exp(r*t)
- Logistic: dN/dt = rN(1 - N/K)
- Runge-Kutta 4 integration for logistic model
- Return population at any time and doubling time

## Status

Quarantine - pending review.

## Location

`packages/tools/population-growth.ts`
