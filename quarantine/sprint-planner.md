# sprint-planner

Agile sprint planner with story points, team velocity, capacity, and auto-assignment.

## Requirements
- createSprint({ name, startDate, endDate, teamCapacity })
- addStory(sprint, { title, points, assignee, priority })
- calculateLoad(sprint): returns { totalPoints, capacity, loadPercent }
- autoAssign(sprint, team[]): distributes unassigned stories by capacity
- renderBoard(sprint): ASCII kanban view grouped by assignee

## Status

Quarantine - pending review.

## Location

`packages/tools/sprint-planner.ts`
