# research-provenance

Provenance sidecar generator - tracks sources consulted, accepted, rejected, and verification status for any research artifact

## Requirements
- Export createProvenance(slug) returning a provenance tracker
- Methods: addSource(url, status), addClaim(text, sourceUrl, verified), toMarkdown()
- Track rounds of research, total sources found vs accepted vs rejected
- Generate <slug>.provenance.md sidecar file alongside the research output

## Status

Quarantine - pending review.

## Location

`packages/tools/research-provenance.ts`
