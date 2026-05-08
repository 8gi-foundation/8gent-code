# growth-hack-analyzer

Scores and prioritizes growth experiments using ICE (Impact, Confidence, Ease) framework.

## Requirements
- addExperiment(backlog, { name, impact, confidence, ease, owner })
- iceScore(experiment): (impact + confidence + ease) / 3
- prioritize(backlog): sorts by ICE score descending
- renderRoadmap(backlog): markdown growth experiment roadmap

## Status

Quarantine - pending review.

## Location

`packages/tools/growth-hack-analyzer.ts`
