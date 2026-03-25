# task-priority-matrix

## Tool Name
`TaskMatrix`

## Description
Eisenhower matrix for task prioritization. Classifies tasks into four quadrants based on urgency (1-10) and importance (1-10) scores:

| Quadrant | Urgency | Importance | Action |
|----------|---------|------------|--------|
| do | high | high | Do immediately |
| schedule | low | high | Plan and schedule |
| delegate | high | low | Hand off if possible |
| eliminate | low | low | Drop or defer indefinitely |

Importance is weighted at 60%, urgency at 40% for final scoring - reflecting the Eisenhower intent that importance drives long-term value.

## Status
quarantine

## Integration Path
1. Import `TaskMatrix` from `packages/tools/task-priority-matrix.ts`
2. Wire into `packages/eight/tools.ts` as a tool definition
3. Expose via CLI: `8gent matrix add "Fix login bug" --urgency 8 --importance 9`
4. Optionally surface in TUI as a task sidebar panel

## API

```ts
import { TaskMatrix } from "../packages/tools/task-priority-matrix";

const matrix = new TaskMatrix();
matrix.addTask("Deploy hotfix", 9, 9);      // do
matrix.addTask("Write docs", 3, 8);         // schedule
matrix.addTask("Reply to Slack", 7, 2);     // delegate
matrix.addTask("Reorganise desktop", 2, 1); // eliminate

const sorted = matrix.sortByPriority();
const summary = matrix.categorize();
const q = matrix.getQuadrant("Deploy hotfix"); // "do"
```

## Files
- `packages/tools/task-priority-matrix.ts` - core implementation (self-contained, no deps)
- `quarantine/task-priority-matrix.md` - this file
