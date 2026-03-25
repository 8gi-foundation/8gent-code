import * as fs from 'fs';
import * as path from 'path';

/**
 * Serializes a value to a deterministic string representation.
 * @param value - The value to serialize.
 * @returns The serialized string.
 */
export function serialize(value: any): string {
  return JSON.stringify(value, null, 2);
}

/**
 * Compares a value against the stored snapshot.
 * @param value - The value to compare.
 * @param name - The name of the snapshot.
 * @returns True if the value matches the snapshot, false otherwise.
 */
export function matchSnapshot(value: any, name: string): boolean {
  const serialized = serialize(value);
  const snapshotPath = path.join(__dirname, '__snapshots__', `${name}.json`);
  
  try {
    const storedSnapshot = fs.readFileSync(snapshotPath, 'utf-8');
    if (storedSnapshot === serialized) return true;
    
    console.error(`Snapshot mismatch for ${name}`);
    console.error(getDiff(storedSnapshot, serialized));
    return false;
  } catch (e) {
    console.error(`Snapshot ${name} not found. Expected: ${serialized}`);
    return false;
  }
}

/**
 * Updates the snapshot with the given value.
 * @param name - The name of the snapshot.
 * @param value - The value to save as the new baseline.
 */
export function updateSnapshot(name: string, value: any): void {
  const serialized = serialize(value);
  const snapshotPath = path.join(__dirname, '__snapshots__', `${name}.json`);
  fs.writeFileSync(snapshotPath, serialized);
}

/**
 * Generates a diff between two strings.
 * @param a - The first string.
 * @param b - The second string.
 * @returns The diff output.
 */
function getDiff(a: string, b: string): string {
  const aLines = a.split('\n');
  const bLines = b.split('\n');
  let diff = '';
  
  for (let i = 0; i < Math.max(aLines.length, bLines.length); i++) {
    const lineA = aLines[i] || '';
    const lineB = bLines[i] || '';
    if (lineA !== lineB) {
      diff += `Line ${i + 1}:\n  Expected: ${lineA}\n  Received: ${lineB}\n`;
    }
  }
  
  return diff;
}