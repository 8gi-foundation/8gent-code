type Backend = {
  id: string;
};

interface LoadBalancerConfig {
  algorithm: 'round-robin' | 'weighted' | 'least-connections';
  backends: Backend[];
  weights?: number[];
  connections?: { [id: string]: number };
  healthCheck?: {
    path: string;
    interval: number;
    threshold: number;
  };
}

/**
 * Creates a round-robin load balancer configuration.
 * @param backends - List of backend servers.
 * @returns Load balancer configuration.
 */
export function roundRobin(backends: Backend[]): LoadBalancerConfig {
  return { algorithm: 'round-robin', backends };
}

/**
 * Creates a weighted load balancer configuration.
 * @param backends - List of backend servers.
 * @param weights - Corresponding weights for each backend.
 * @returns Load balancer configuration.
 */
export function weighted(backends: Backend[], weights: number[]): LoadBalancerConfig {
  if (backends.length !== weights.length) {
    throw new Error('Backends and weights must be the same length');
  }
  return { algorithm: 'weighted', backends, weights };
}

/**
 * Creates a least-connections load balancer configuration.
 * @param backends - List of backend servers.
 * @param connections - Current connection counts per backend.
 * @returns Load balancer configuration.
 */
export function leastConnections(backends: Backend[], connections: { [id: string]: number }): LoadBalancerConfig {
  return { algorithm: 'least-connections', backends, connections };
}

/**
 * Attaches health check configuration.
 * @param config - Load balancer configuration.
 * @param options - Health check parameters.
 * @returns Updated configuration.
 */
export function healthCheck(config: LoadBalancerConfig, options: { path: string; interval: number; threshold: number }): LoadBalancerConfig {
  return { ...config, healthCheck: options };
}

/**
 * Renders load balancer configuration as formatted string.
 * @param lb - Load balancer configuration.
 * @returns Formatted configuration string.
 */
export function renderConfig(lb: LoadBalancerConfig): string {
  return JSON.stringify(lb, null, 2);
}