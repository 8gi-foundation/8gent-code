# Capabilities Deck vs Claude Suite + Codex

Author: Samantha (8PO), 8GI Product Office.
Sign-off date: 2026-04-24.
Version: v1.0.

## What this deck is

A board-level product decision document that answers the single question blocking four parallel threads:

What is the shape of "abilities" for 8gent, and how do we express it across the public /abilities docs route, the 8gent Computer PRD, and an honest competitive matrix?

## Who this deck is for

**Primary audience:** 8GI Foundation internal board. James as approver.

**Secondary audience:** future public-facing adaptation. After James signs off, the body-parts taxonomy becomes the spine of the `/abilities` page on 8gent.dev (Variant A replaces the current table stub), and the appendix matrix becomes a sibling comparison page.

## What is in the deck

1. Taxonomy pick: Body parts (Variant A), with one-sentence reason.
2. Shipped PR confirmation: PRs #1716 through #1727, all verified merged, all accepted as canonical.
3. Stealth and hold-back list: three customer-visible hold-backs (HyperAgent RL kernel, 8gent Computer security internals, aidhd.dev).
4. Filled taxonomy: body parts spine populated with every shipped and roadmap ability, cross-referenced to PR numbers.
5. Appendix. Comparison matrix vs Claude Code, Claude Desktop, Claude API, OpenAI Codex (Apr 16 2026 set).
6. 8gent Computer positioning statement (~80 words).
7. What this unblocks: 8gent-dev #5, #6, #8, and the feature-scope table in 8gent-code #1746.

## Files in this folder

| File | Purpose |
|------|---------|
| `deck.md` | Markdown source, slide-per-heading. |
| `deck.pdf` | Compiled PDF, pandoc output. |
| `voiceover.md` | KittenTTS narration script. |
| `voiceover.wav` | Rendered audio, Luna voice, KittenTTS. |
| `README.md` | This file. |

## Constraints honoured

- No em dashes anywhere in deck, voiceover, or PR body.
- No fabricated competitor claims. Where public docs are silent, cells are marked "unclear".
- KittenTTS only for voice. No ElevenLabs.
- No Co-Authored-By trailers on commits.
- Variant drafts on 8gent-dev were not touched. This deck informs later wiring.

## What happens next

1. James reviews the PDF and the voiceover in Telegram.
2. On approval, a follow-up PR on 8gent-dev replaces `content/docs/abilities/index.mdx` with the Body-parts spine (Variant A), and `content/docs/abilities/comparison.mdx` hosts the appendix matrix (from Variant C).
3. 8gent Computer PRD feature-scope table is re-sorted against the spine. Owner: Rishi.
4. 3D humanoid v1 for /abilities becomes the follow-on (`docs/design/2026-04-24-abilities-3d-spec.md` on 8gent-dev).
