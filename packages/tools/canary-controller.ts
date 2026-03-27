type CanaryState = {
  currentPercent: number;
  errorRate: number;
  latencyP99: number;
};

const canaries = new Map<string, CanaryState>();

/**
 * Initialize a canary release with specified version and initial traffic percentage.
 */
function startCanary(config: any, { canaryVersion, initialPercent }: { canaryVersion: string; initialPercent: number }): void {
  canaries.set(canaryVersion, { currentPercent: initialPercent, errorRate: 0, latencyP99: 0 });
}

/**
 * Increase the traffic percentage for the specified canary.
 */
function promote(canary: string, incrementPercent: number): void {
  const state = canaries.get(canary);
  if (state) {
    state.currentPercent = Math.min(state.currentPercent + incrementPercent, 100);
  }
}

/**
 * Rollback the specified canary to 0% traffic.
 */
function rollback(canary: string, reason: string): void {
  const state = canaries.get(canary);
  if (state) {
    state.currentPercent = 0;
  }
}

/**
 * Check if rollback is needed based on error rate and latency metrics.
 */
function shouldRollback(canary: string, { errorRate, latencyP99 }: { errorRate: number; latencyP99: number }, thresholds: { error: number; latency: number }): boolean {
  return errorRate > thresholds.error || latencyP99 > thresholds.latency;
}

/**
 * Render the current status of the specified canary.
 */
function renderStatus(canary: string): string {
  const state = canaries.get(canary);
  if (state) {
    return `Canary ${canary}: ${state.currentPercent}% traffic, error rate ${state.errorRate}%, latency P99 ${state.latencyP99}ms`;
  }
  return 'Canary not found';
}

export { startCanary, promote, rollback, shouldRollback, renderStatus };