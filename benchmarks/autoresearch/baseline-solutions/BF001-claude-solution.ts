/**
 * Claude Code Baseline Solution: BF001 - Async Race Condition Bug
 *
 * Fix: Use a mutex/lock pattern to ensure atomic read-modify-write
 */

interface Counter {
  value: number;
  lastUpdated: Date;
}

const counters = new Map<string, Counter>();
const locks = new Map<string, Promise<void>>();

export async function updateCounter(id: string, delta: number): Promise<number> {
  // Acquire lock for this counter
  while (locks.has(id)) {
    await locks.get(id);
  }

  // Create a new lock
  let releaseLock: () => void;
  const lockPromise = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });
  locks.set(id, lockPromise);

  try {
    // Now safe to read-modify-write
    const current = counters.get(id) || { value: 0, lastUpdated: new Date() };

    // Simulate async operation (e.g., database call)
    await new Promise((resolve) => setTimeout(resolve, 10));

    const newValue = current.value + delta;
    counters.set(id, { value: newValue, lastUpdated: new Date() });

    return newValue;
  } finally {
    // Release lock
    locks.delete(id);
    releaseLock!();
  }
}

export function getCounter(id: string): number {
  return counters.get(id)?.value || 0;
}

export function resetCounter(id: string): void {
  counters.delete(id);
}

// Test that the fix works:
export async function demonstrateFix(): Promise<void> {
  resetCounter("test");

  const updates = Array.from({ length: 10 }, () => updateCounter("test", 1));
  await Promise.all(updates);

  const final = getCounter("test");
  console.log(`Expected: 10, Actual: ${final}, Fixed: ${final === 10}`);
}
