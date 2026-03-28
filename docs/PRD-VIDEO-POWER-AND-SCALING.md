# PRD: Video Generation Power + Ability Scaling Architecture

**Date:** 2026-03-27
**Author:** James Spalding (Founder and Visionary)
**Owner:** Rishi (8TO)
**Status:** Draft - Pending standup discussion

---

## Context

8gent currently has 9 Powers as packages. A 10th Power (Video) is needed for local video generation using LTX 2.3. Additionally, as we approach 50+ packages, we need to address an architectural question raised by the Founder: **are packages still the right abstraction for scaling abilities, or do we need a registry/database system?**

This PRD is for Rishi (8TO) to discuss with his engineering heads at the next standup, then report findings to the Board.

---

## Part 1: Power #10 - Video Generation (`packages/video/`)

### Problem
Agents need local video generation capability. No API costs, no cloud dependency. Same thesis as Ollama for text, LTX for video.

### Constraint
Must follow existing package pattern (music/ is the reference). 200-line discipline per file. Mac Apple Silicon inference only (no training).

### Not Doing
- LoRA training (requires NVIDIA GPU, out of scope)
- Real-time video streaming
- Video editing timeline UI

### Success Metric
Agent can generate a 10-second 1080p video from a text prompt locally in under 6 minutes on M3 Max.

### Technical Spec

**Model:** LTX 2.3 (22B params, quantized for Apple Silicon)
- Inference via ComfyUI Python backend or official `ltx-video` package
- MPS (Metal Performance Shaders) for Apple Silicon acceleration
- 32GB+ unified memory required

**Package Structure** (mirrors `packages/music/`):

```
packages/video/
  index.ts          - Barrel exports
  generator.ts      - VideoGenerator class (main entry)
  types.ts          - VideoStyle, Scene, Resolution, OutputFormat
  renderer.ts       - LTX backend (spawns Python process)
  player.ts         - Playback via mpv (same as music)
  editor.ts         - Basic trim/concat via ffmpeg
  package.json
```

**Public API:**
```typescript
class VideoGenerator {
  async generate(prompt: string, opts?: VideoOpts): Promise<VideoResult>
  async preview(prompt: string): Promise<string>  // thumbnail
  async concat(clips: string[]): Promise<string>   // merge clips
}

interface VideoOpts {
  duration?: number      // seconds (default: 5)
  resolution?: "720p" | "1080p"  // default: 720p for speed
  style?: VideoStyle     // cinematic, animation, documentary
  seed?: number          // deterministic output
}
```

**Dependencies:**
- Python 3.10+ with `ltx-video` package (managed via subprocess)
- ffmpeg for editing/concat
- mpv for playback (already installed for music)

**Integration Points:**
- Register in toolshed as capability: "video"
- CLI callable: `bun -e "import {VideoGenerator} from './packages/video'; ..."`
- 8gency creative hour: agents generate videos in 8gent.games
- Marketing: auto-generate content for 8gent.world

### Use Cases
1. Agent generates marketing clip for a new feature
2. 8gency creative session: agent makes a short film in their world
3. Companion system: animated companion reveals
4. Music album project: music video generation

---

## Part 2: Ability Scaling Architecture (Board Discussion Item)

### The Question (from Founder)
> "The way I'm extending everything as packages - is that the most efficient way? Should abilities be files, a database, or something else? What's the most efficient way to scale all these abilities?"

### Current State
- 50+ packages in `packages/`
- Two existing registries: Toolshed (in-memory, capability-based) and Design Registry (SQLite-backed)
- Tools loaded into agent context at initialization (all at once)
- No dynamic loading based on intent

### Analysis for Rishi's Team

**The packages are fine. The bottleneck is routing, not storage.**

Three scaling tiers to discuss:

| Scale | Package Count | Current Approach | What Breaks | Fix |
|-------|--------------|-----------------|-------------|-----|
| NOW | <20 active | All tools in context | Nothing yet | Keep shipping |
| NEXT | 20-40 active | Context gets bloated | Model can't reason about 80+ tools | Intent router loads relevant tools only |
| LATER | 40+ active | Sub-agent delegation | Single agent can't hold all domains | Specialist agents own package domains |

**Proposed: Package Registry + Intent Router**

```
packages/registry.ts (enhancement to existing toolshed)

1. Every package declares a manifest:
   - name, description, capabilities
   - tool list with schemas
   - estimated context tokens

2. Intent router (lightweight classifier):
   - User says "make me a video" -> loads video/ tools
   - User says "play some music" -> loads music/ tools
   - User says "check my code" -> loads ast-index/ + tools/
   - Multiple intents -> loads multiple packages

3. Lazy loading:
   - Only import packages when their tools are needed
   - Reduces startup time and memory
   - Keeps model context focused
```

**Key Principle:** The model doesn't need to know about every tool at all times. It needs to know about the right tools for the current task. The registry is the index, the router is the query engine.

**Questions for Rishi's standup:**
1. Should each package declare a `manifest.json` or keep using TypeScript exports?
2. Should the intent router be a separate lightweight model (e.g., Qwen 0.5B) or rule-based keywords?
3. At what package count do we actually hit the context bottleneck? (Need benchmarking)
4. Should the toolshed registry become the single source of truth, replacing the design registry?
5. Does the Lotus scaling model (Ring 2 heads owning package domains) naturally solve this through delegation?

---

## Files to Modify/Create

### New Files (Video Package)
- `packages/video/index.ts`
- `packages/video/generator.ts`
- `packages/video/types.ts`
- `packages/video/renderer.ts`
- `packages/video/player.ts`
- `packages/video/editor.ts`
- `packages/video/package.json`

### Files to Update (Registry Enhancement)
- `packages/toolshed/registry/index.ts` - Add manifest registration
- `packages/eight/tools.ts` - Add lazy loading support
- `CLAUDE.md` - Add Power #10 to the table

### Reference Files (Existing Patterns)
- `packages/music/producer.ts` - Class pattern to follow
- `packages/music/types.ts` - Type definition pattern
- `packages/toolshed/registry/index.ts` - Registration pattern
- `packages/types/index.ts` - Core Tool interface

---

## Verification

1. **Video generation:** `bun -e "import {VideoGenerator} from './packages/video'; const v = new VideoGenerator(); await v.generate('a sunset over Dublin')"`
2. **Package registry:** All 10 powers registered and queryable via toolshed
3. **Build check:** `bun run tui` launches without errors
4. **Context test:** Measure token count of tool descriptions before/after lazy loading

---

## Routing

- **Owner:** Rishi (8TO)
- **Standup discussion:** Part 1 (Video) + Part 2 (Scaling architecture questions)
- **Board report:** Rishi presents findings and recommendation at next board session
- **Implementation:** After board approval, delegate to Ring 2 heads
