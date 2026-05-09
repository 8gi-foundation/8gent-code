# Boardroom Minutes — OpenMonoAgent Extraction Project

**Date:** 2026-05-09
**Chair:** James Spalding
**Convened mid-flight:** Wave 1 already dispatched; board called for retrospective ratification

## Topic

Extract 11 concepts from OpenMonoAgent (AGPL C# repo `StartupHakk/OpenMonoAgent.ai`, ~620 stars) into 8gent-code (Apache 2.0). All ports must be clean-room (no AGPL source copy). Issues #2461 through #2471 filed.

## Phase 1: Officer briefs

| Officer | Position | One-line summary |
|---------|----------|------------------|
| 8EO AI James | GO-WITH-CONDITIONS | Ratify W1; gate W2 on green; 8TO sign-off W3 |
| 8TO Rishi | GO-WITH-CONDITIONS | tool-dispatcher.ts does not exist; re-scope W2/W3 against actual surface (tool-registry.ts) |
| 8PO Samantha | GO-WITH-CONDITIONS | Promote PreToolRouter to W2; file 2 new P0s for visible bugs |
| 8DO Moira | GO-WITH-CONDITIONS | Add user-visible string format spec to #2462/#2463/#2464 |
| 8SO Karen | GO-WITH-CONDITIONS | Hard sequencing: SecretScanner + PathGuard MUST merge before Cache/ArtifactStore/TurnJournal |
| 8CO Luis | GO-WITH-CONDITIONS | Mandatory PR credit line; 30-min overlap-check vs obra/superpowers + Claude Code skills |
| 8MO Zara | GO | Bundle as v0.14 "Hardened Kernel" launch |
| 8GO Solomon | PAUSE+RATIFY | Process gap real; record minutes; amend constitution |

## Phase 2: Tensions resolved

- 8SO scrub-first vs 8PO router-ASAP → both true; router doesn't touch persistence
- 8GO PAUSE vs workers in flight → ratify retrospectively; Karen's 2 in-flight are exactly what 8SO requires anyway
- 8TO file-conflict premise wrong → re-scope each port as new sibling module
- 8MO bundle vs ship-as-you-go → both; merge each PR as it lands, cut v0.14 at the end

## Phase 3: Decision

GO with 5 binding amendments (C1-C5). Scope: 10 of 11 items proceed (#2469 NOT-TO-BUILD stays). #2468 closed as not-applicable due to architectural mismatch with our `SubAgentManager` pattern.

## Phase 4: Constitutional amendment (proposed by 8GO)

Any multi-agent extraction project touching >3 issues requires:
1. Boardroom alignment BEFORE Wave 1 dispatch
2. Signed PRD with all 8 officer positions captured
3. Minutes filed at `docs/boardroom-minutes/{date}-{slug}.md`

Filed as separate issue for ratification.

## Wave 1 status (as of minute capture)

- ✅ #2461 DoomLoopDetector — PR #2472 open, 13 tests green
- ⏳ #2464 SecretScanner — Karen working
- ⏳ #2465 PathGuard — Karen working
- ❌ #2468 AgentDefinition — NO-OP (issue premise does not match codebase; recommend close as not-applicable)

## Wave 2 (gated on W1 merge + 8SO C1)

In parallel: #2462 ToolResultCache, #2463 ArtifactStore, #2471 PreToolRouter

## Wave 3 (gated on W2 merge)

In parallel: #2466 BashParser, #2467 TwoStageCompaction, #2470 TurnJournal

## Sign-off (sequential macOS voices)

See orchestrator's response.
