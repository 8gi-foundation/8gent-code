# stakeholder-map

Stakeholder mapping with influence/interest matrix, communication plan, and engagement strategy.

## Requirements
- addStakeholder(map, { name, role, influence, interest, sentiment })
- quadrant(stakeholder): returns manage-closely | keep-satisfied | keep-informed | monitor
- communicationPlan(map): generates touchpoint frequency by quadrant
- renderMatrix(map): 2x2 ASCII influence/interest grid with names
- exportCSV(map): stakeholder list with all attributes

## Status

Quarantine - pending review.

## Location

`packages/tools/stakeholder-map.ts`
