/**
 * Deployment state manager for blue-green deployments.
 */
export class Deployment {
  app: string;
  blue: string;
  green: string;
  currentLive: 'blue' | 'green';
  history: Array<{ time: Date; to: 'blue' | 'green' }>;

  constructor(app: string, blue: string, green: string) {
    this.app = app;
    this.blue = blue;
    this.green = green;
    this.currentLive = 'blue';
    this.history = [];
  }
}

/**
 * Creates a new deployment state object.
 * @param {Object} params - Deployment parameters
 * @param {string} params.app - Application name
 * @param {string} params.blue - Blue environment version
 * @param {string} params.green - Green environment version
 * @returns {Deployment} New deployment state
 */
export function createDeployment({
  app,
  blue,
  green,
}: {
  app: string;
  blue: string;
  green: string;
}): Deployment {
  return new Deployment(app, blue, green);
}

/**
 * Switches the live environment to the specified environment.
 * @param {Deployment} deployment - Deployment state
 * @param {string} to - Target environment ('blue' or 'green')
 */
export function cutover(deployment: Deployment, to: 'blue' | 'green'): void {
  if (deployment.currentLive !== to) {
    deployment.currentLive = to;
    deployment.history.push({ time: new Date(), to });
  }
}

/**
 * Reverts to the previous live environment.
 * @param {Deployment} deployment - Deployment state
 */
export function rollback(deployment: Deployment): void {
  const previous = deployment.currentLive === 'blue' ? 'green' : 'blue';
  deployment.currentLive = previous;
  deployment.history.push({ time: new Date(), to: previous });
}

/**
 * Returns the current deployment status.
 * @param {Deployment} deployment - Deployment state
 * @returns {Object} Deployment status with live, standby, version, and last cutover
 */
export function status(deployment: Deployment): {
  live: 'blue' | 'green';
  standby: 'blue' | 'green';
  version: string;
  lastCutover: Date | null;
} {
  const live = deployment.currentLive;
  const standby = live === 'blue' ? 'green' : 'blue';
  const version = live === 'blue' ? deployment.blue : deployment.green;
  const lastCutover = deployment.history.length > 0 ? deployment.history[deployment.history.length - 1].time : null;
  return { live, standby, version, lastCutover };
}

/**
 * Renders a formatted deployment status card.
 * @param {Deployment} deployment - Deployment state
 * @returns {string} Formatted status card
 */
export function renderStatus(deployment: Deployment): string {
  const { live, standby, version, lastCutover } = status(deployment);
  return `Deployment: ${deployment.app}\nLive: ${live} (v${version})\nStandby: ${standby}\nLast cutover: ${lastCutover ? lastCutover.toISOString() : 'N/A'}`;
}