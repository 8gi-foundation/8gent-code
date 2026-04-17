/**
 * Represents a launch checklist with phases and items.
 */
export class Checklist {
  phases: { id: string; name: string; critical: boolean; itemIds: string[] }[];
  items: Map<string, { description: string; owner: string; isComplete: boolean; timestamp?: Date }>;

  constructor(
    phases: { id: string; name: string; critical: boolean; itemIds: string[] }[],
    items: Map<string, { description: string; owner: string; isComplete: boolean; timestamp?: Date }>
  ) {
    this.phases = phases;
    this.items = items;
  }
}

/**
 * Creates a structured launch plan with phases and items.
 * @param phases - Array of phase objects with id, name, critical, and itemIds.
 * @param items - Array of item objects with id, description, and owner.
 * @returns A new Checklist instance.
 */
export function createChecklist(
  phases: { id: string; name: string; critical: boolean; itemIds: string[] }[],
  items: { id: string; description: string; owner: string }[]
): Checklist {
  const itemMap = new Map(
    items.map(item => [item.id, { ...item, isComplete: false }])
  );
  return new Checklist(phases, itemMap);
}

/**
 * Marks an item as completed with a timestamp.
 * @param checklist - The checklist instance.
 * @param itemId - The ID of the item to mark as complete.
 */
export function complete(checklist: Checklist, itemId: string): void {
  const item = checklist.items.get(itemId);
  if (item) {
    item.isComplete = true;
    item.timestamp = new Date();
  }
}

/**
 * Calculates the readiness score of the checklist.
 * @param checklist - The checklist instance.
 * @returns Object with overall percentage and per phase percentages.
 */
export function readinessScore(checklist: Checklist): { overall: number; perPhase: Map<string, number> } {
  const totalItems = checklist.items.size;
  let completed = 0;
  const perPhase = new Map<string, number>();

  for (const phase of checklist.phases) {
    let phaseCompleted = 0;
    for (const itemId of phase.itemIds) {
      if (checklist.items.get(itemId)?.isComplete) {
        phaseCompleted++;
      }
    }
    perPhase.set(phase.name, (phaseCompleted / phase.itemIds.length) * 100);
    completed += phaseCompleted;
  }

  return {
    overall: (completed / totalItems) * 100,
    perPhase
  };
}

/**
 * Identifies items in critical phases that are incomplete.
 * @param checklist - The checklist instance.
 * @returns Array of blocked items with phase and item details.
 */
export function blockers(checklist: Checklist): { phase: string; item: { id: string; description: string; owner: string } }[] {
  const result: { phase: string; item: { id: string; description: string; owner: string } }[] = [];
  for (const phase of checklist.phases) {
    if (phase.critical) {
      for (const itemId of phase.itemIds) {
        const item = checklist.items.get(itemId);
        if (item && !item.isComplete) {
          result.push({
            phase: phase.name,
            item: { id: itemId, description: item.description, owner: item.owner }
          });
        }
      }
    }
  }
  return result;
}

/**
 * Generates a markdown document of the checklist.
 * @param checklist - The checklist instance.
 * @returns Markdown string representing the checklist.
 */
export function renderMarkdown(checklist: Checklist): string {
  let md = '# Launch Checklist\n\n';
  const score = readinessScore(checklist);
  md += `## Readiness Score\nOverall: ${score.overall.toFixed(1)}%\n`;
  for (const [phase, percent] of score.perPhase) {
    md += `Phase ${phase}: ${percent.toFixed(1)}%\n`;
  }
  md += '\n## Phases\n';
  for (const phase of checklist.phases) {
    md += `### ${phase.name}\n`;
    for (const itemId of phase.itemIds) {
      const item = checklist.items.get(itemId);
      const status = item?.isComplete ? '✅' : '❌';
      md += `- ${status} [${itemId}] ${item?.description} (Owner: ${item?.owner})\n`;
    }
  }
  return md;
}