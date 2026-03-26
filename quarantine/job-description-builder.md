# job-description-builder

Structured job description builder with role summary, responsibilities, requirements, and benefits.

## Requirements
- buildJD({ title, level, team, summary, responsibilities[], requirements[], benefits[] })
- renderMarkdown(jd): full job description document
- scoreInclusion(jd): checks for gendered or exclusionary language, returns issues[]
- exportATS(jd): plain text format for ATS systems

## Status

Quarantine - pending review.

## Location

`packages/tools/job-description-builder.ts`
