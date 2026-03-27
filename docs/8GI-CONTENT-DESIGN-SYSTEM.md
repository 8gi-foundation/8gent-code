# 8GI Content Design System - Visual Spec for 5 Launch Assets

**Version:** 1.0
**Date:** 2026-03-26
**Author:** Moira (8DO) - Chief Design Officer
**Status:** Design spec. Not final assets. Execute from this document.

---

## 1. Shared Visual Language

All five assets share a single visual system. No asset should look like it came from a different brand.

### 1.1 Color Palette

| Token | Hex | Role |
|-------|-----|------|
| Amber Primary | `#D4890C` | Primary accent. Headlines, key UI elements, active states. |
| Amber Light | `#E8A832` | Highlights, badges, hover states, emphasis borders. |
| Amber Deep | `#A86B08` | Secondary accent. Borders, underlines, subtle weight. |
| Background Dark | `#0C0A07` | Primary dark background for social assets. |
| Card Surface | `#1A1612` | Elevated surfaces on dark bg. Cards, panels, code blocks. |
| Card Border | `#3A3020` | Warm border for cards and dividers. Not gray. Never gray. |
| Light Text | `#FFFCF5` | Primary text on dark backgrounds. Warm white, not pure white. |
| Muted Text | `#9E8E70` | Secondary text, captions, metadata. Warm, not gray. |
| Competitor Muted | `#5A5550` | Used only in Asset 1 for "Corporate" column treatment. |
| Competitor Warm Fade | `#7A6E5A` | Used only in Asset 1 for "Digital Twin" column treatment. |

**Banned:** Any hue between 270-350 (purple, pink, violet, magenta). Any cool gray. Pure `#FFFFFF` or `#000000`.

### 1.2 Typography

| Role | Font | Weight | Size (social) | Size (article) |
|------|------|--------|---------------|----------------|
| Primary headline | Fraunces | 800 | 48-64px | 36-42px |
| Secondary headline | Fraunces | 700 | 32-40px | 28-32px |
| Body text | Inter | 400 | 18-20px | 16-18px |
| Body emphasis | Inter | 600 | 18-20px | 16-18px |
| Code / monospace | JetBrains Mono | 400 | 14-16px | 14-16px |
| Captions / meta | Inter | 400 | 14px | 13px |
| Wordmark "8GI." | Fraunces | 800 | 24-32px | 20-24px |

The period in "8GI." is always rendered in `#D4890C` amber. The "8GI" letters use `#FFFCF5` on dark backgrounds or `#0C0A07` on light backgrounds.

### 1.3 Card Style

- Corner radius: 12px for large cards, 8px for inline cards, 4px for badges
- Border: 1px solid `#3A3020`
- Background: `#1A1612` on dark surfaces
- Shadow: none (terminal aesthetic, flat design)
- Hover/focus: border transitions to `#D4890C`, plus a subtle outer glow of `#D4890C` at 15% opacity, 0 0 12px spread
- Padding: 24px standard, 16px compact

### 1.4 Iconography

- Style: minimal stroke-based line icons
- Stroke width: 1.75px
- Corner style: rounded caps and joins
- Color: `#FFFCF5` default, `#D4890C` for active/highlighted states
- Size: 24x24px standard, 48x48px for featured icons (Asset 1 column headers)
- Source: design from scratch or use Lucide icon set as base. No filled icons. No emoji as icons.

### 1.5 Layout Grid

- Social assets (1200px wide): 12-column grid, 24px gutters, 48px margins
- Square assets (1200x1200): 12-column grid, 24px gutters, 48px margins
- Article headers (1200x675): 12-column grid, 24px gutters, 48px margins

### 1.6 Spacing Scale

Base unit: 8px. All spacing is multiples of 8.

| Token | Value |
|-------|-------|
| xs | 8px |
| sm | 16px |
| md | 24px |
| lg | 32px |
| xl | 48px |
| xxl | 64px |

---

## 2. Asset 1 - Three Approaches to AI (Social Visual)

### Purpose

A single-image comparison that positions 8GI's collective model against corporate AI and digital twin approaches. This is the sharpest positioning asset. It should make the viewer stop scrolling.

### Format

- Primary: 1200x675px (Twitter/Threads landscape)
- Secondary: 1080x1080px (Instagram/LinkedIn square)
- Background: `#0C0A07`

### Layout - Landscape (1200x675)

```
┌──────────────────────────────────────────────────────────────────┐
│  48px top margin                                                 │
│                                                                  │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐   │
│  │   CORPORATE  │  │ DIGITAL TWIN │  │   THE COLLECTIVE     │   │
│  │              │  │              │  │                      │   │
│  │   [brain]    │  │   [mirror]   │  │   [lotus/octagon]   │   │
│  │              │  │              │  │                      │   │
│  │  "Same       │  │  "Your       │  │  "Your brain,       │   │
│  │   answer     │  │   brain,     │  │   your machine,     │   │
│  │   for        │  │   their      │  │   our patterns"     │   │
│  │   everyone"  │  │   servers"   │  │                      │   │
│  │              │  │              │  │                      │   │
│  └──────────────┘  └──────────────┘  └──────────────────────┘   │
│                                                                  │
│  ────────────────────────────────────────────────────────────    │
│                                                                  │
│  8GI.                    Three approaches to intelligence.       │
│                                                                  │
│  48px bottom margin                                              │
└──────────────────────────────────────────────────────────────────┘
```

### Column Treatments

**Column 1 - "Corporate AI"**
- Card background: `#141210` (barely above the main bg)
- Border: 1px solid `#2A2520` (dimmest border)
- Icon: single brain outline, `#5A5550` (muted)
- Headline: "Corporate" in Inter 600, `#5A5550`
- Quote: Inter 400, `#5A5550`
- Overall feel: functional but lifeless. Deliberately de-emphasized.

**Column 2 - "Digital Twin"**
- Card background: `#1A1612`
- Border: 1px solid `#3A3020`
- Icon: mirror/reflection outline, `#7A6E5A` (warmer than Corporate, but faded)
- Headline: "Digital Twin" in Inter 600, `#7A6E5A`
- Quote: Inter 400, `#7A6E5A`
- Overall feel: warmer than Corporate, but still not fully alive. Better direction, wrong destination.

**Column 3 - "The Collective"**
- Card background: `#1A1612`
- Border: 1px solid `#D4890C` (full amber)
- Outer glow: `#D4890C` at 12% opacity, 0 0 16px
- Icon: octagonal lotus (8-sided, concentric), `#D4890C` with inner rings in `#E8A832`
- Headline: "The Collective" in Fraunces 700, `#D4890C`
- Quote: Inter 400, `#FFFCF5` (full brightness)
- Overall feel: alive. The only column with full color and warmth. The eye goes here.

### Bottom Bar

- Thin divider line: 1px, `#3A3020`, full width minus margins
- Left: "8GI." wordmark in Fraunces 800, `#FFFCF5` with amber period
- Right: "Three approaches to intelligence." in Inter 400, `#9E8E70`
- 48px below the cards, 48px above bottom edge

### Square Variant (1080x1080)

Same content, but columns stack vertically instead of horizontally. Each column becomes a horizontal row with icon on the left (48x48) and text on the right. The third row gets the full amber treatment. Bottom bar remains at the bottom.

### Icon Specs

- **Brain (Corporate):** Single brain outline. Smooth curves. No detail lines inside. Represents monolithic thinking. 48x48px, 1.75px stroke.
- **Mirror (Digital Twin):** Rectangle with a vertical line of symmetry and a small reflected silhouette. Represents copying. 48x48px, 1.75px stroke.
- **Lotus/Octagon (Collective):** Three concentric octagons. Inner octagon filled with `#D4890C` at 20% opacity. Represents expanding rings of intelligence. 48x48px, 1.75px stroke for outlines.

---

## 3. Asset 2 - dev.to Article Layout

### Purpose

Long-form article titled "Why we wrote a Constitution before a marketing page." Explains 8GI's governance-first approach. This is the trust-building asset.

### Header Image (1200x675)

- Background: `#0C0A07`
- Center: stylized scroll/document icon, amber stroke outline, with faint amber glow behind it
- The scroll has a subtle octagonal seal at the bottom (referencing the lotus)
- Top-right corner: "8GI." watermark in Fraunces 800, `#D4890C` at 30% opacity
- Bottom: article title in Fraunces 800, `#FFFCF5`, centered, max 2 lines
- Subtitle: "8GI. - Collective Intelligence" in Inter 400, `#9E8E70`, below the title

### Article Structure

The article follows this arc. Each section heading uses Fraunces 700 in the dev.to markdown.

```
1. The Problem: Uniformity
   - Every AI company ships the same product with a different logo
   - "Personalization" means prompt templates, not governance
   - Users are tenants, not members

2. The Decision: Constitution First
   - Before any marketing page, we wrote 10 constitutional articles
   - Each article governs how agents behave, how data is owned, who decides what
   - The Constitution is public. The source code is public. The governance is public.

3. The 10 Articles (summary table)
   - Render as a styled table or numbered list with one-line descriptions
   - Link to the full Constitution on 8gent.world

4. Why This Matters
   - Trust is the moat
   - You cannot bolt governance onto a product after launch
   - The companies that win the next decade will be the ones that started with values

5. What We Are Building
   - Brief overview of the 8GI lotus model (link to manifesto, do not over-explain)
   - Invitation to read, contribute, or join
```

### Pull Quote Style

Pull quotes appear as amber-bordered cards within the article body.

```
┌─────────────────────────────────────────────┐
│ ▌ "You cannot bolt governance onto a        │
│ ▌  product after launch."                   │
│                                             │
│                          - 8GI Constitution │
└─────────────────────────────────────────────┘
```

- Left border: 3px solid `#D4890C`
- Background: `#1A1612` (or dev.to's dark card equivalent in their markdown)
- Quote text: Inter 500 italic, `#FFFCF5`
- Attribution: Inter 400, `#9E8E70`, right-aligned

On dev.to, implement with blockquote markdown. The header image carries the visual brand.

### Code Block Style

Any code examples in the article use:
- Font: JetBrains Mono 400
- Background: `#0C0A07`
- Border: 1px solid `#3A3020`
- Syntax highlighting: amber for keywords, warm white for identifiers, muted for comments

dev.to handles code block styling natively. The spec here is for any custom-rendered versions (blog mirrors, presentations).

### Samantha's Condition

The article leads with the Constitution and governance story. Technical implementation details (Fly.io, NemoClaw, daemon protocol) are not mentioned. The article is about values and structure, not architecture.

---

## 4. Asset 3 - Paperclip Competitive Response

### Purpose

A quote-tweet-style response to Paperclip's "Advanced AI Agents" video. Respectful positioning. Not an attack. A contrast.

### Format

- 1200x675px image for attachment, OR text-only tweet with the image as optional
- The image version includes a blurred/dimmed screenshot of Paperclip's thumbnail

### Layout (Image Version)

```
┌──────────────────────────────────────────────────────────────┐
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  [Paperclip thumbnail - blurred, 40% opacity]         │  │
│  │                                                        │  │
│  │  Dimmed. Not mocked. Just context.                     │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
│  "Same org chart. Different soul."                           │
│                                                              │
│  ┌────────┐  ┌──────────────────────────────────────────┐   │
│  │ [seal] │  │  Governed by constitution, not investors. │   │
│  └────────┘  │  Open source. Human-first.                │   │
│              └──────────────────────────────────────────┘   │
│                                                              │
│  8GI.                                                        │
└──────────────────────────────────────────────────────────────┘
```

### Specifications

- Background: `#0C0A07`
- Paperclip thumbnail area: 60% width, centered, with 4px rounded corners, `#3A3020` border, image at 40% opacity with a slight gaussian blur (4px)
- Response line: Fraunces 700, 36px, `#FFFCF5`, centered below the thumbnail
- Constitution badge: small octagonal seal icon (24x24), `#D4890C` stroke, positioned left of the supporting text
- Supporting text: Inter 400, 16px, `#9E8E70`
- Lotus miniature: tiny concentric octagon mark (16x16), `#A86B08`, bottom-right corner as a subtle brand mark
- Wordmark: "8GI." bottom-left, Fraunces 800, `#FFFCF5` with amber period

### Text-Only Version (Tweet Copy)

```
Same org chart. Different soul.

They ship agents for productivity.
We govern agents by constitution.

Both valid. One is ours.

8GI.world/constitution
```

### Tone Rules

- No mocking Paperclip's product or team
- No claims of superiority
- Frame as philosophical difference, not competitive attack
- The word "better" does not appear anywhere
- Do not name Paperclip in the image text (the thumbnail provides context)

---

## 5. Asset 4 - Sentience Complement (Thread)

### Purpose

A 3-4 post thread acknowledging Sentience's work on AI identity while clarifying how 8GI's approach differs. This is a complement, not a critique.

### Format

- Platform: Twitter/X thread (3-4 posts)
- No images required, but Post 1 can optionally include a simple graphic
- Each post under 280 characters

### Thread Structure

**Post 1 (The Acknowledgment)**
```
Sentience is asking the right question:
what happens when AI develops identity?

Most companies ignore this entirely.
They deserve credit for taking it seriously.

We have a different answer. Thread:
```

Optional image for Post 1: Two shapes side by side on `#0C0A07` background. Left: a mirror outline (Sentience's approach - reflection). Right: concentric octagons (8GI's approach - collective emergence). Below: "Same question. Different geometry." in Inter 400, `#9E8E70`.

**Post 2 (The Distinction)**
```
Sentience builds mirrors.
An AI that knows itself.

8GI builds circles.
Humans and agents that know each other.

Not a better mirror.
A better circle.
```

**Post 3 (The Principle)**
```
We wrote a Constitution before a landing page.

10 articles. Public. Forkable.
Every agent in our collective is bound by it.
Every human member is bound by it equally.

Identity without governance is just a personality test.
```

**Post 4 (The Invitation)**
```
If you are building in this space:
read our manifesto.

Not because we are right.
Because the conversation matters
more than any single answer.

8GI.world/manifesto
```

### Visual Style (Optional Post 1 Image)

- Dimensions: 1200x675px
- Background: `#0C0A07`
- Left shape: mirror icon outline, `#7A6E5A` (warm faded, same as Asset 1 Digital Twin treatment)
- Right shape: concentric octagon, `#D4890C` with inner rings `#E8A832` and `#A86B08`
- Dividing line: vertical, dashed, `#3A3020`, centered between shapes
- Caption below: Inter 400, 18px, `#9E8E70`
- "8GI." bottom-right, Fraunces 800, small

### Tone Rules

- Never use the word "but" after praising Sentience (it negates the praise)
- Frame as parallel paths, not competing ones
- "Different" not "better"
- Link to manifesto, not product pages
- Do not explain 8GI's technical architecture

---

## 6. Asset 5 - Lotus Social Diagram

### Purpose

A standalone visual explaining the 8GI organizational model. Clean enough for social sharing, detailed enough to convey the structure.

### Format

- 1200x1200px square (optimal for Twitter, LinkedIn, Instagram)
- Background: `#0C0A07`

### Layout

```
┌────────────────────────────────────────────────────┐
│                                                    │
│  THE LOTUS MODEL                                   │
│  How 8GI scales.                                   │
│                                                    │
│              ┌ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┐               │
│            /  Ring 3: Leads (512)    \              │
│           │  ┌ ─ ─ ─ ─ ─ ─ ─ ─ ┐    │             │
│           │ /  Ring 2: Heads (64) \   │             │
│           ││  ┌ ─ ─ ─ ─ ─ ─ ┐    │  │             │
│           ││ /  Ring 1: Chiefs (8) \  │             │
│           │││  ┌ ─ ─ ─ ─ ┐    │  ││ │             │
│           │││  │ Seed (1) │    │  ││ │             │
│           │││  └ ─ ─ ─ ─ ┘    │  ││ │             │
│           ││ \                 /  ││ │             │
│           ││  └ ─ ─ ─ ─ ─ ─ ┘   ││ │             │
│           │ \                    / │ │             │
│           │  └ ─ ─ ─ ─ ─ ─ ─ ─ ┘  │ │             │
│            \                       / │             │
│              └ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┘               │
│                                                    │
│  1 + 8 + 64 + 512 = 585                           │
│                                                    │
│  8GI.                                              │
│                                                    │
└────────────────────────────────────────────────────┘
```

### Octagon Specifications

All shapes are octagons (8 sides), not circles. The octagonal geometry is the brand.

**Ring 0 - Seed**
- Shape: regular octagon, 80px wide
- Fill: `#D4890C` at 25% opacity
- Stroke: 2px solid `#D4890C`
- Center label: "Seed" in Inter 600, 14px, `#FFFCF5`
- Below label: "(1)" in Inter 400, 12px, `#9E8E70`

**Ring 1 - Chiefs**
- Shape: regular octagon, 220px wide, centered on Ring 0
- Fill: none (transparent)
- Stroke: 1.75px solid `#D4890C`
- Label: "Ring 1: Chiefs" in Inter 500, 14px, `#D4890C`, positioned at the top edge of the octagon (outside)
- Count: "(8)" in Inter 400, 12px, `#9E8E70`, next to label

**Ring 2 - Heads**
- Shape: regular octagon, 400px wide, centered
- Fill: none
- Stroke: 1.75px solid `#E8A832`
- Label: "Ring 2: Heads" in Inter 500, 14px, `#E8A832`, top edge
- Count: "(64)" next to label

**Ring 3 - Leads**
- Shape: regular octagon, 600px wide, centered
- Fill: none
- Stroke: 1.75px solid `#A86B08`
- Label: "Ring 3: Leads" in Inter 500, 14px, `#A86B08`, top edge
- Count: "(512)" next to label

### Title Area (Top)

- "THE LOTUS MODEL" in Fraunces 800, 42px, `#FFFCF5`
- "How 8GI scales." in Inter 400, 20px, `#9E8E70`
- Top margin: 64px
- Space between title and subtitle: 8px
- Space between subtitle and diagram: 48px

### Stats Bar (Below Diagram)

- "1 + 8 + 64 + 512 = 585" in JetBrains Mono 400, 18px, `#D4890C`
- Centered horizontally
- 32px below the outermost octagon

### Wordmark (Bottom)

- "8GI." in Fraunces 800, 28px, `#FFFCF5` with amber period
- Bottom-left corner, 48px from edges

### Connection Lines (Optional Enhancement)

Thin radial lines (0.5px, `#3A3020`) from the Seed octagon outward through each ring, at 8 evenly spaced angles (every 45 degrees), suggesting the 8-fold multiplication. These are subtle background texture, not primary UI.

---

## 7. Security Conditions (Karen, 8SecO)

These rules apply to all five assets. No exceptions.

| Rule | Detail |
|------|--------|
| No infrastructure details | Do not mention Fly.io, Amsterdam, NemoClaw, SQLite, daemon protocols, or any deployment specifics. |
| No database schemas | Do not reference table structures, FTS5, embeddings dimensions, or memory store internals. |
| No config specifics | Do not show YAML snippets, .env variables, or policy engine configurations. |
| Values and vision only | Public content speaks about what 8GI believes and how it organizes. Not how it is built. |
| No team member full names | In public content, reference roles ("our CTO", "the security officer") not individual names. The Seed (James Spalding) is the exception as a public founder. |
| Link destinations | Only link to 8gent.world, 8gent.dev, 8gentos.com, or 8GI social accounts. No internal docs. |

---

## 8. Brand Voice Checklist

Before publishing any asset, verify against this checklist.

- [ ] No em dashes anywhere (use hyphens or rewrite)
- [ ] No purple, pink, violet, or magenta (hues 270-350)
- [ ] No banned words: revolutionary, groundbreaking, game-changing, disruptive, cutting-edge
- [ ] No stat padding (only state what actually exists with evidence)
- [ ] No enthusiasm inflation (state what is, not what might be)
- [ ] Voice is plural ("we" not "I", except in clearly attributed quotes from the Seed)
- [ ] Tone is direct, not dramatic
- [ ] Tone is inevitable, not urgent
- [ ] Every factual claim is backed by a link or verifiable reference
- [ ] No dollar values attached to benchmarks or capabilities
- [ ] Pure white (#FFFFFF) and pure black (#000000) are not used as fill colors

---

## 9. File Naming Convention

When final assets are produced, name them as follows:

```
8gi-content-01-three-approaches-landscape.png
8gi-content-01-three-approaches-square.png
8gi-content-02-constitution-header.png
8gi-content-03-paperclip-response.png
8gi-content-04-sentience-complement.png  (optional image)
8gi-content-05-lotus-diagram.png
```

Source files (Figma, SVG, or HTML):
```
8gi-content-01-three-approaches.fig  (or .svg / .html)
8gi-content-02-constitution-header.fig
8gi-content-03-paperclip-response.fig
8gi-content-04-sentience-complement.fig
8gi-content-05-lotus-diagram.fig
```

---

## 10. Production Notes

- All social images should be exported at 2x resolution (2400px wide for 1200px targets) for retina displays
- Compress PNGs with pngquant or equivalent (target under 500KB per image)
- SVG versions should be provided for any asset that may need to scale (lotus diagram, icons)
- Fonts must be embedded or outlined in final production files
- Test all images against Twitter's image crop preview (landscape images crop center, square images display fully)
- Test against LinkedIn's feed rendering (images may be compressed further)

---

*This spec is complete. Any designer - human or AI - should be able to produce all five assets from this document without additional briefing.*
