# research-pipeline

4-stage adversarial research pipeline - researcher finds sources, writer drafts, verifier checks URLs, reviewer audits adversarially

## Requirements
- Export createResearchPipeline(topic) returning a pipeline orchestrator
- 4 stages: research (gather sources with URLs), write (draft from sources only), verify (fetch every URL, remove unverifiable claims), review (adversarial audit with FATAL/MAJOR/MINOR severity)
- File-based intermediate state - each stage writes to disk, next stage reads files not inline content
- Provenance tracking - record sources consulted, accepted, rejected per stage

## Status

Quarantine - pending review.

## Location

`packages/tools/research-pipeline.ts`
