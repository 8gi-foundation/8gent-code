export interface CheckStatus {
  healthy: boolean;
  lastCheck: number;
  consecutiveFailures: number;
}

export interface HealthMonitor {
  start(): void;
  stop(): void;
  getStatus(): Record<string, CheckStatus>;
  on(event: "change", handler: (name: string, status: CheckStatus) => void): void;
  off(event: "change", handler: (name: string, status: CheckStatus) => void): void;
}

export function createHealthMonitor(
  checks: Record<string, () => Promise<boolean>>,
  intervalMs = 30_000
): HealthMonitor {
  const status: Record<string, CheckStatus> = {};
  const listeners = new Set<(name: string, status: CheckStatus) => void>();
  let timer: ReturnType<typeof setInterval> | null = null;

  for (const name of Object.keys(checks)) {
    status[name] = { healthy: true, lastCheck: 0, consecutiveFailures: 0 };
  }

  async function runChecks(): Promise<void> {
    await Promise.all(
      Object.entries(checks).map(async ([name, fn]) => {
        let healthy = false;
        try {
          healthy = await fn();
        } catch {
          healthy = false;
        }

        const prev = status[name];
        const consecutiveFailures = healthy ? 0 : prev.consecutiveFailures + 1;
        const next: CheckStatus = { healthy, lastCheck: Date.now(), consecutiveFailures };

        if (prev.healthy !== healthy) {
          status[name] = next;
          for (const handler of listeners) handler(name, next);
        } else {
          status[name] = next;
        }
      })
    );
  }

  return {
    start() {
      if (timer !== null) return;
      void runChecks();
      timer = setInterval(() => void runChecks(), intervalMs);
    },

    stop() {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },

    getStatus() {
      return { ...status };
    },

    on(_event: "change", handler: (name: string, status: CheckStatus) => void) {
      listeners.add(handler);
    },

    off(_event: "change", handler: (name: string, status: CheckStatus) => void) {
      listeners.delete(handler);
    },
  };
}
