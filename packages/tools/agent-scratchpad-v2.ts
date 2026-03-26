/**
 * Entry type for the scratchpad.
 */
interface Entry {
  type: 'thought' | 'plan' | 'fact' | 'task' | 'result';
  content: string;
}

/**
 * Adds an entry to the scratchpad.
 * @param pad - The scratchpad array.
 * @param type - The type of entry.
 * @param content - The content of the entry.
 */
export function add(pad: Entry[], type: Entry['type'], content: string): void {
  pad.push({ type, content });
}

/**
 * Retrieves all fact entries from the scratchpad.
 * @param pad - The scratchpad array.
 * @returns Array of fact entries.
 */
export function facts(pad: Entry[]): Entry[] {
  return pad.filter(e => e.type === 'fact');
}

/**
 * Retrieves all pending task entries from the scratchpad.
 * @param pad - The scratchpad array.
 * @returns Array of task entries.
 */
export function tasks(pad: Entry[]): Entry[] {
  return pad.filter(e => e.type === 'task');
}

/**
 * Renders the scratchpad with entries grouped by type.
 * @param pad - The scratchpad array.
 * @returns Formatted string of the scratchpad.
 */
export function render(pad: Entry[]): string {
  const grouped = pad.reduce((acc, entry) => {
    if (!acc[entry.type]) {
      acc[entry.type] = [];
    }
    acc[entry.type].push(entry.content);
    return acc;
  }, {} as Record<Entry['type'], string[]>);

  return Object.entries(grouped)
    .map(([type, entries]) => 
      `${type.toUpperCase()}: ${entries.join(', ')}`)
    .join('\n');
}

/**
 * Summarizes the scratchpad contents into a single paragraph.
 * @param pad - The scratchpad array.
 * @returns A summary paragraph.
 */
export function summarize(pad: Entry[]): string {
  const entriesByType = pad.reduce((acc, entry) => {
    if (!acc[entry.type]) {
      acc[entry.type] = [];
    }
    acc[entry.type].push(entry.content);
    return acc;
  }, {} as Record<Entry['type'], string[]>);

  const parts = [];
  for (const [type, entries] of Object.entries(entriesByType)) {
    if (entries.length > 0) {
      parts.push(`${type} include ${entries.slice(0, 2).join(', ')}`);
    }
  }
  return `Summary: ${parts.join(', ')}.`;
}