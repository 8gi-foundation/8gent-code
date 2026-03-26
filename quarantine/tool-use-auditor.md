# tool-use-auditor

Audits agent tool calls for safety, relevance, and compliance against a policy.

## Requirements
- definePolicy({ blockedTools[], requireApproval[], maxCallsPerTool{} })
- auditCall(policy, toolCall): returns { allowed, reason, requiresApproval }
- auditSession(policy, calls[]): session-level compliance check
- renderReport(audit): markdown tool usage report with violations

## Status

Quarantine - pending review.

## Location

`packages/tools/tool-use-auditor.ts`
