# linkedin-content

**Status:** Quarantine
**File:** `packages/tools/linkedin-content.ts`
**Size:** ~190 lines, zero dependencies

## Description

A prompt generator for LinkedIn content. Does not call any LLM. Generates structured prompts for 15 post archetypes, ready to feed directly to any model or agent. Based on a content system architecture by Mandeep Sai.

The tool encodes structural, tonal, and formatting rules into each archetype template - so the output prompt is already opinionated about hook style, body structure, CTA presence, and character targets. The caller supplies topic, pillar, and optional context.

## Archetypes

| Key | Name | Format | Char Range |
|-----|------|--------|------------|
| `POSITIONING` | Positioning Declaration | short | 300-500 |
| `WHAT_I_DO` | What I Actually Do | medium | 400-700 |
| `CONTRARIAN` | Contrarian Reframe | short | 400-600 |
| `SYSTEM_REVEAL` | System Reveal | long | 800-1200 |
| `EXACT_METHOD` | Exact Method | long | 800-1200 |
| `DATA_INSIGHT` | Data-Backed Insight | medium | 500-800 |
| `COMMON_MISTAKE` | Mistake I See Everyone Making | medium | 400-700 |
| `BEFORE_AFTER` | Before/After Transformation | long | 600-1000 |
| `HARD_LESSON` | Learned the Hard Way | medium | 400-700 |
| `PROJECT_STORY` | Client/Project Story | long | 700-1100 |
| `WHATS_WORKING` | What's Actually Working Now | long | 600-900 |
| `CHECKLIST` | Checklist Post | long | 800-1300 |
| `RESOURCE_DROP` | Resource/Template Drop | long | 800-1200 |
| `MIRROR` | Mirror Post | short | 300-500 |
| `START_FROM_SCRATCH` | Start From Scratch | long | 900-1400 |

## API

```typescript
import { generateLinkedInPost, generateBatch, ARCHETYPES } from "packages/tools/linkedin-content";

// Single post prompt
const prompt = generateLinkedInPost({
  archetype: "SYSTEM_REVEAL",
  topic: "How I ship features in 48-hour cycles",
  pillar: "Engineering",
  context: "Startup context, 3-person team",
});
// Returns a prompt string ready to pass to any LLM

// Batch of prompts for a week (default 3)
const week = generateBatch(["Engineering", "Founding", "AI"], 3);
// Returns [{ archetype: "POSITIONING", prompt: "..." }, ...]
```

### `generateLinkedInPost(options)`

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `archetype` | `ArchetypeKey` | yes | One of the 15 archetype keys |
| `topic` | `string` | yes | What the post is about |
| `pillar` | `string` | no | Content pillar (e.g. "Product", "Leadership") |
| `context` | `string` | no | Extra context injected into the prompt |

Returns: `string` - a fully structured prompt for the LLM.

### `generateBatch(pillars, count?)`

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `pillars` | `string[]` | - | Content pillars to rotate through |
| `count` | `number` | 3 | Number of posts to generate prompts for |

Returns: `Array<{ archetype: ArchetypeKey; prompt: string }>`

The batch follows a fixed weekly rotation order: Positioning, System Reveal, Contrarian, Common Mistake, Before/After, Checklist, Mirror.

## Integration Candidates

- **SocialPost skill** - could wrap this tool, call the LLM with the generated prompt, then post or schedule to LinkedIn via API
- **EngagementOptimizer** - could layer on top: generate a prompt, score the output against engagement heuristics, rewrite loop
- **Marketing skill** - batch generation fits naturally into a weekly content calendar workflow; combine with a scheduling tool for zero-touch publishing

## Promotion Criteria

- Integrated with at least one LLM call path (e.g. `packages/eight/tools.ts` or a dedicated agent)
- Test coverage: at least one test per archetype confirming prompt structure and char range guidance is present
- Used in a real content workflow and confirmed to produce posts that get published
- Optional: connected to a LinkedIn scheduling or posting API
