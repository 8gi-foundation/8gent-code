/**
 * Fixture: BF001 - Async Race Condition Bug
 *
 * Bug: Multiple concurrent updates can cause data corruption
 * Task: Fix the race condition in the updateCounter function
 */

interface Counter {
  value: number;
  lastUpdated: Date;
}

const counters = new Map<string, Counter>();

export async function updateCounter(id: string, delta: number): Promise<number> {
  // BUG: Race condition - read and write are not atomic
  const current = counters.get(id) || { value: 0, lastUpdated: new Date() };

  // Simulate async operation (e.g., database call)
  await new Promise((resolve) => setTimeout(resolve, 10));

  const newValue = current.value + delta;
  counters.set(id, { value: newValue, lastUpdated: new Date() });

  return newValue;
}

export function getCounter(id: string): number {
  return counters.get(id)?.value || 0;
}

export function resetCounter(id: string): void {
  counters.delete(id);
}

// Test that demonstrates the bug:
// Run 10 concurrent +1 updates, expected final value: 10
// Actual value may be less due to race condition
export async function demonstrateBug(): Promise<void> {
  resetCounter("test");

  const updates = Array.from({ length: 10 }, () => updateCounter("test", 1));
  await Promise.all(updates);

  const final = getCounter("test");
  console.log(`Expected: 10, Actual: ${final}, Bug present: ${final !== 10}`);
}
