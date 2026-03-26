# kanban-state-machine

Kanban board as a formal state machine with columns, WIP limits, and throughput metrics.

## Requirements
- createBoard(columns[], wipLimits{})
- moveCard(board, cardId, toColumn): throws if WIP limit exceeded
- getBlockedColumns(board): returns columns at WIP limit
- cycleTime(card): days from first move to Done
- throughput(board, days): cards completed per day over last N days
- renderBoard(board): ASCII board with card counts per column

## Status

Quarantine - pending review.

## Location

`packages/tools/kanban-state-machine.ts`
