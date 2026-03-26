# customer-journey-mapper

Maps customer journey stages with touchpoints, emotions, pain points, and opportunities.

## Requirements
- addStage(journey, { name, touchpoints, emotion, painPoints, opportunities })
- identifyGaps(journey): returns stages with no opportunities defined
- renderTimeline(journey): ASCII timeline of stages
- exportJSON(journey): clean serializable structure
- scoreExperience(journey): average emotion score across stages

## Status

Quarantine - pending review.

## Location

`packages/tools/customer-journey-mapper.ts`
