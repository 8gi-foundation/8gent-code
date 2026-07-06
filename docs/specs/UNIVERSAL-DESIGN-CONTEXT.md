# Universal Design Context

Status: Proposed (design-only, no source changes yet)
Owner: James Spalding
Related: `docs/specs/MINICPM-GATEKEEPER.md`, `packages/design-systems/`

## Thesis

> Our structure out-does the quality of our weights combined.

Every artifact the harness produces - a PDF, a video deck, an HTML site, a React
app - must inherit excellent design *regardless of which model wrote it*. The
model supplies content; the **structure** (a shared design-token index the model
cannot skip) supplies the taste. A weak local model producing a slide deck should
still emit our palette, our type scale, our component classes, because those come
from the index, not from the weights.

## Problem (one sentence)

`packages/design-systems/` is a real, seeded SQLite index of 56 design systems
(HSL palettes, typography, Tailwind component classes), but it is wired into
*only* the HTML/React agent path and is *opt-in via a tool call*; the PDF path and
the HyperFrames video/deck path pull nothing from it, so design quality is a
coin-flip per surface.

## Constraint

- **Reuse, do not rebuild.** The index, its query API (`suggestForProject`,
  `generateCssVariables`, `generateTailwindConfig`, `getComplete`), and the seed
  are already correct. This spec adds ONE resolver and wires the surfaces that
  currently ignore it. No schema change.
- **Mandatory, not suggested.** Today `write_file` *nudges* the agent to call
  `suggest_design`. The resolver makes tokens a non-optional input to every
  generation surface.
- **One source of truth.** All surfaces resolve through the same function so a
  deck, a PDF, and a React app of the same project are visually identical.

## What we are NOT doing

- Not adding screenshots, a vector index, or an FTS layer to the DB (search stays
  `LIKE`-based; that is enough for token lookup).
- Not changing the 56 themes or `extractor.ts`.
- Not building a new design system. This is plumbing, not design work.

## Success metric

For a fixed project brief run through all four surfaces with the SAME resolved
system id:

1. **Token parity:** the primary/accent/background hexes and heading font in the
   generated PDF, video deck, HTML, and React app are byte-identical to
   `generateCssVariables(systemId)`. Automated diff test.
2. **No bare output:** each surface's generator receives a non-empty design
   context or throws (fail-closed), verified by a unit test that stubs an empty DB.
3. **Manifest trace:** every generated artifact carries a `designSystemId` in its
   metadata so we can prove which system it inherited.

---

## Current wiring (from source)

Consumers of `@8gent/design-systems` today:

| Path | File | How it reads |
|---|---|---|
| HTML/React agent tools | `packages/eight/tools.ts` (`suggest_design`, `query_design_system`) | opt-in tool call |
| Same, AI-SDK map | `packages/ai/tools.ts` | opt-in tool call |
| Adaptive build pipeline | `packages/orchestration/adaptive-pipeline.ts` `designTokens()` (~line 712) | direct `bun:sqlite`, injects palette+typography into orchestrator/engineer prompts |
| Autoresearch arena | `benchmarks/autoresearch/portfolio-arena.ts` `designTokens()` | direct SQL |

**Gaps:** `make_pdf` (commit `e50e0bd3`) imports nothing from the design DB. The
HyperFrames video/deck path (see the cross-repo `create-video-hyperframes` /
`deck2video` flow) has no design-token input. Two of James's four named surfaces
are undressed.

Also note: `designTokens()` is **duplicated** (adaptive-pipeline + portfolio-arena
each have their own copy). That duplication is the smell this resolver removes.

---

## Design: one resolver, four call sites

### The resolver (new): `packages/design-systems/context.ts`

```ts
export interface DesignContext {
  systemId: string;
  name: string;
  cssVariables: string;      // generateCssVariables(systemId)
  tailwindConfig: string;    // generateTailwindConfig(systemId)
  hexPalette: Record<string, string>;
  typography: { headingFont: string; bodyFont: string; scale: string[] };
  promptBlock: string;       // pre-rendered markdown the model must honor
}

// Resolve once per job. `hint` may be a projectType, an explicit system id/name,
// or free text -> suggestForProject()/search() picks the best system.
// Fail-closed: throws DesignContextUnavailable if the DB is empty/missing,
// so no surface can silently render un-branded.
export function resolveDesignContext(hint: {
  projectType?: string; systemId?: string; freeText?: string;
}): DesignContext;

// Convenience for prompt-injection surfaces (decks, HTML, React via the pipeline).
export function designPromptBlock(ctx: DesignContext): string;
```

`promptBlock` is the key artifact: a compact, model-agnostic instruction the
generator prepends - "Use ONLY these tokens: --primary: #..., heading font: ...,
component classes: ...". This is how a weak local model still ships our taste: the
structure carries it.

`resolveDesignContext` is the single home for the DB read that
`adaptive-pipeline.designTokens()` and `portfolio-arena.designTokens()` currently
duplicate; both get refactored to call it (removes the duplication smell).

### The four call sites

| Surface | Where to wire | Mechanism |
|---|---|---|
| HTML / React | `packages/orchestration/adaptive-pipeline.ts` | replace local `designTokens()` with `resolveDesignContext()`; inject `promptBlock` (already injects tokens - this is a refactor + make it non-skippable) |
| PDF | the `make_pdf` tool (`feat/make-pdf-tool` branch) | before render, `resolveDesignContext()` -> apply `cssVariables` + fonts to the PDF's HTML/CSS template; stamp `designSystemId` in metadata |
| Video deck | HyperFrames deck skill / `deck2video` (cross-repo `8gent-glasses` relay) | pass `cssVariables` + `hexPalette` into the deck HTML template the renderer captures; **cross-repo, tracked as its own issue** |
| Agent-written files | `packages/eight/tools.ts` `write_file` design gate | upgrade the *nudge* to inject `promptBlock` into context automatically when a UI/PDF/deck file is being written |

### Selection: how a job picks its system

- Explicit wins: caller passes `systemId`/name.
- Else `suggestForProject(projectType)` (the scored mapping table already exists).
- Else `search(freeText)` on the brief.
- The chosen `systemId` is threaded through the whole job so all surfaces of one
  request agree. Store it on the session/job context object.

### Where MiniCPM (sister spec) helps

The router-classifier seat can, as a cheap side-decision, classify the brief's
*design intent* (e.g. "gaming" vs "health" vs "luxury") to feed
`suggestForProject`, and the judge seat can gate an artifact on token-parity
("does the output actually use the resolved palette? abstain if unsure"). Optional
phase-2 tie-in, not required for the resolver to land.

---

## Rollout (phased)

| Phase | Change | Gate |
|---|---|---|
| 1 | Add `context.ts` resolver + refactor the two `designTokens()` copies to use it | parity test green; no behavior change on HTML path |
| 2 | Wire `make_pdf` to the resolver + `designSystemId` metadata | a generated PDF's tokens == `generateCssVariables()` |
| 3 | Wire the video/deck path (cross-repo issue) | deck tokens match |
| 4 | Upgrade `write_file` gate from nudge to auto-inject `promptBlock` | agent-written UI inherits tokens without a tool call |

## Rollback

The resolver is additive. Each surface wiring is independent and flagged
(`EIGHT_DESIGN_CONTEXT_ENFORCE`). Reverting a surface = drop its resolver call;
the old opt-in path still works. No schema/data change.

## Open questions

- Fail-closed vs fail-soft when the DB is missing on a fresh install: recommend
  fail-closed on shared/prod surfaces (matches No-Hardcoded-Data ethos), fail-soft
  with a seeded default only on a throwaway local dev DB.
- Video path lives partly in `8gent-glasses` - the deck/video wiring is a
  cross-repo issue and should be filed there, referencing this spec.
