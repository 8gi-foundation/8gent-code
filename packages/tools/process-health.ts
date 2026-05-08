/**
 * Returns current memory usage in MB.
 * @returns {Object} Memory metrics in MB
 */
export function memoryUsage(): { rss: number; heapUsed: number; heapTotal: number } {
  const usage = process.memoryUsage();
  return {
    rss: usage.rss / 1e6,
    heapUsed: usage.heapUsed / 1e6,
    heapTotal: usage.heapTotal / 1e6
  };
}

/**
 * Returns CPU usage in milliseconds.
 * @returns {Object} CPU metrics in ms
 */
export function cpuUsage(): { user: number; system: number } {
  const { user, system } = process.cpuUsage();
  return {
    user: user / 1e6,
    system: system / 1e6
  };
}

/**
 * Returns process uptime in seconds.
 * @returns {number} Uptime in seconds
 */
export function uptime(): number {
  return process.uptime();
}

/**
 * Returns all metrics at once.
 * @returns {Object} All metrics
 */
export function snapshot(): { memory: { rss: number; heapUsed: number; heapTotal: number }; cpu: { user: number; system: number }; uptime: number } {
  return {
    memory: memoryUsage(),
    cpu: cpuUsage(),
    uptime: uptime()
  };
}

/**
 * Checks if process is unhealthy based on thresholds.
 * @param {Object} thresholds - Memory and CPU thresholds
 * @returns {boolean} True if any metric exceeds thresholds
 */
export function isUnhealthy(thresholds: { memory: { rss: number; heapUsed: number; heapTotal: number }; cpu: { user: number; system: number } }): boolean {
  const { memory, cpu } = snapshot();
  return (
    memory.rss > thresholds.memory.rss ||
    memory.heapUsed > thresholds.memory.heapUsed ||
    memory.heapTotal > thresholds.memory.heapTotal ||
    cpu.user > thresholds.cpu.user ||
    cpu.system > thresholds.cpu.system
  );
}