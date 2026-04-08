# SVG Mascot Animation Research

**Context:** @ayotomcs (Designer Boy) created animated SVG versions of the Claude mascot using GSAP. 931 likes, 56K views on X. This explores whether the same approach works for Lil Eight.

## How SVG + GSAP Mascot Animation Works

### The Pattern

1. **Character built in SVG** - each body part is a separate `<g>` or `<path>` element with an ID (`#left-eye`, `#antenna`, `#body-upper`)
2. **GSAP timelines drive motion** - `gsap.timeline({ repeat: -1 })` creates looping idle animations
3. **Transform origins set per-part** - each limb rotates from its joint, not its center
4. **Easing creates life** - `elastic.out`, `power2.inOut` make mechanical parts feel organic
5. **Layered loops** - breathing on a 3s loop, blinking on a random 2-5s interval, antenna on a 1.5s loop - all independent timelines

### Why It Goes Viral

- Single file, no build step, loads instantly
- Scales to any size (vector)
- Easy to embed anywhere - `<iframe>`, `<object>`, or inline SVG
- Interactive potential - hover states, click reactions, cursor following
- Lightweight - typically 5-15KB vs 50-200KB for sprite sheets

### Key GSAP Methods Used

| Method | Purpose |
|--------|---------|
| `gsap.to()` | Animate a property to a value |
| `gsap.timeline()` | Sequence animations |
| `gsap.set()` | Set initial state without animation |
| `yoyo: true` | Reverse animation on complete (breathing) |
| `transformOrigin` | Set rotation pivot per element |
| `stagger` | Offset identical animations (eye blinks) |

## Lil Eight as Animated SVG

### Character Anatomy (from `generate-sprites.ts`)

The pixel-art Lil Eight is a 16px grid robot with an "8" shaped body:

- **Antenna** - 2px wide, orange tip (`#E8610A`), accent shaft (`#FF8C42`)
- **Head/Upper body** - top circle of the "8" shape, dark navy (`#1A1A2E`)
- **Eyes** - two 2x2 orange squares, left at (5,5), right at (9,5)
- **Belt** - orange accent line at the waist (narrow part of "8")
- **Lower body** - bottom circle of the "8"
- **Arms** - dark navy with orange accent hands
- **Legs** - dark navy with orange feet

### SVG Translation

The pixel grid maps cleanly to SVG:
- Each `px()` call becomes a `<rect>` with `rx` for slight rounding
- The "8" silhouette can be a single `<path>` with two connected ellipses
- Eyes become `<rect>` elements that scale to 0 height for blinks
- Antenna becomes a `<line>` + `<circle>` that wobbles

### Idle Animation Breakdown

| Part | Animation | Duration | Easing |
|------|-----------|----------|--------|
| Whole body | Gentle Y bob (breathing) | 3s | `sine.inOut` |
| Eyes | Blink (scaleY: 0 then back) | 0.15s, every 3-5s | `power2.inOut` |
| Antenna tip | Wobble rotation +/- 15deg | 1.5s | `elastic.out` |
| Arms | Slight swing | 2.5s | `sine.inOut` |
| Shadow | Scale with body bob | 3s | `sine.inOut` |

## SVG vs Pixel Art - Tradeoffs

### For Terminal Pet (TUI)

**Pixel art wins.** Terminal rendering is character-grid based. The 64x64 PNG sprites map directly to terminal cells via Kitty/Sixel protocols. SVG would need rasterization, adding complexity with no benefit.

### For Web Presence (8gent.dev, 8gent.world)

**SVG wins decisively.**

| Factor | PNG Sprites | SVG + GSAP |
|--------|-------------|------------|
| File size | 50-200KB atlas | 5-15KB |
| Scaling | Blurry above 64px or pixelated | Crisp at any size |
| Animation | JS frame switching or CSS steps | Smooth tweened motion |
| Interactivity | Hard | Easy (hover, click, cursor track) |
| Embed anywhere | Needs JS loader | `<iframe>` or inline |
| SEO/a11y | Image alt text only | `<title>`, `<desc>`, ARIA roles |
| Mobile perf | Fine | Fine (GPU-accelerated transforms) |
| Brand impression | Retro/indie | Polished/professional |

### Recommendation

**Both.** Keep pixel art for the terminal pet (it fits the TUI aesthetic). Use SVG for all web-facing instances - landing pages, docs, embeds. They're the same character, two rendering modes.

## Could Replace or Complement Sprite Sheets

**Complement, not replace.**

- Terminal pet stays pixel art (sprites/) - that's its native medium
- Web mascot uses SVG (apps/lil-eight/web-mascot.html) - scales, animates, embeds
- Both share the same character design and color palette
- SVG version can have richer animations (cursor following, speech bubbles, mood states) that wouldn't work in terminal

## Implementation

Proof of concept: `apps/lil-eight/web-mascot.html` - standalone HTML file with inline SVG + GSAP CDN. ~150 lines. No build step required.

## References

- GSAP SVG plugin docs: https://gsap.com/docs/v3/Plugins/SVGPlugin/
- @ayotomcs Claude mascot animation: X post with 56K views
- Lil Eight character spec: `apps/lil-eight/generate-sprites.ts` lines 34-77
