# @8gent/design-compose

The design layer of the reference contract.

| Layer | Marker | Model writes | Code produces |
|---|---|---|---|
| Action | `[[TASK]]` / `[[HELM]]` | a description of work | the executed result |
| Data | `[[CLAIM]]` / `[[DERIVE]]` | a reference | the verified value |
| **Design** | **`[[DESIGN]]`** | **an intent** | **the composed spec** |

An officer states what a thing is for and how it should feel. Code composes the
complete design: type ramp, spacing rhythm, colour system with every pair
contrast-checked, layout skeleton, motion tokens with reduced-motion variants,
surfaces, radii. The model never enumerates a spacing scale, never picks a hex,
never does arithmetic on a ratio.

That is what "zero token architecture" means here. The design space is traversed
by **executing code**, not by reasoning in a context window.

---

## Why a new package

There are already two design packages in this repo and they do different jobs.

| Package | What it is | Scale |
|---|---|---|
| `design-systems` | A SQLite registry of themes extracted from the portfolio. Stores and retrieves. | 54 stored themes |
| `design-agent` | An LLM suggester. Reads a project and recommends. | n/a |
| `design-compose` | A generator. Stores nothing, computes everything. | ~1.16 billion admissible designs |

`design-systems` answers "which of our themes fits this?". This package answers
"what is the correct design for this intent?" and derives the answer. Neither
replaces the other, and the name says which is which.

---

## Quick start

```ts
import { search, toCss, toTokens } from "@8gent/design-compose";

const spec = search({ product: "huddle-deck", tone: "stage" }).best;

toCss(spec);     // CSS custom properties, with a reduced-motion block
toTokens(spec);  // plain data for a slide renderer
```

```bash
bun run packages/design-compose/demo.ts    # three designs, refusals, token cost
bun run packages/design-compose/space.ts   # the counting proof
bun test packages/design-compose           # 85 tests
```

---

## The primitive set

Fourteen axes. None has more than 55 positions. They multiply.

| Axis | Positions | Source of the values |
|---|---|---|
| type ratio | 8 | modularscale.com canonical intervals, UI-usable band |
| ramp generator | 3 | geometric, IBM Carbon's recurrence, Utopia fluid `clamp()` |
| space unit | 3 | 4, 5, 8 |
| space family | 3 | Carbon, Utopia and Tailwind multiplier vectors |
| accent hue | 55 legal / 18 warm | 5-degree steps, banned band removed by rendering and testing |
| palette structure | 4 | mono, analogous, split, complementary |
| polarity | 2 | dark, light |
| density | 4 | compact to spacious |
| layout skeleton | 6 | Every Layout primitives |
| measure | 4 | 45 to 75ch |
| motion | 4 | Carbon's 2x3 easing matrix, Material 3 Expressive springs |
| surface | 4 | flat, bordered, raised, inset |
| emphasis | 5 | which channel carries hierarchy |
| radius | 5 | multiples of 4, following M3 ShapeTokens |

**The rule that makes it work:** an axis is only an axis if moving along it does
not invalidate any other axis. Where that broke during the build it was fixed in
the primitive, not papered over. The clearest case is in `palette.ts`: palette
structures originally rotated the secondary hue by absolute degrees, so under the
warm profile a "complementary" pairing was always a cool blue and 58 per cent of
the warm lattice was being refused. Rotating by **position in the available hue
set** instead restored orthogonality and is also what a designer actually does
inside a constrained palette.

---

## The counting proof

Run `bun run packages/design-compose/space.ts`. It computes the number from the
axis arrays at runtime, so it cannot drift from the code. Nothing in this README
is typed by hand.

```
8 x 3 x 3 x 3 x 18 x 4 x 2 x 4 x 6 x 4 x 4 x 4 x 5 x 5  =  1,194,393,600
```

That is the **warm profile**, which is the default. With `warmOnly: false` the
hue axis widens from 18 to 55 and the addressable space is **3,649,536,000**.

Addressable is the easy number. The one that matters is how much of it survives
the constraint gate, and that is **measured**, not asserted: a deterministic
prime-stride walk of the lattice (no RNG, so it reproduces on any machine)
composes real specs and counts the refusals.

```
warm profile      97.5% admissible  (95% CI 96.6-98.3%, n=1309)  ~1.16 billion
full legal range  97.2% admissible  (95% CI 96.7-97.7%, n=4000)  ~3.55 billion

The only rule that fires in a lattice walk is space.distinct, at ~2.5%.
```

Both numbers are in the tool's output with their intervals. If the admissible
fraction had come back at 2 per cent, the tool would say so.

---

## Constraints: refuse, never correct

Every rule in `constraints.ts` **throws**. None warns, none returns a fixed
value, none nudges a bad colour towards a good one.

A composer that silently corrected a violet accent to orange would produce a
valid design and destroy the information that the intent was wrong. Nobody would
learn it, and the rule would rot until someone shipped violet by hand and nothing
complained. **The refusal is the evidence**, exactly like the planted-lie test in
`packages/verify`.

| Rule | What it enforces | Source |
|---|---|---|
| `brand.hue` | no hue in 270-350 on the rendered pixel | BRAND.md |
| `brand.warm` | warm band by default, switchable for documented exemptions | BRAND.md |
| `copy.emDash` | no U+2014 or U+2015 in any generated string | BRAND.md |
| `a11y.contrast` | WCAG 2.2 AA: 4.5:1 body, 3:1 large, 3:1 non-text | SC 1.4.3, 1.4.11 |
| `a11y.textSpacing` | body line-height at least 1.5 | SC 1.4.12 headroom |
| `a11y.target` | interactive targets at least 24 x 24 CSS px | SC 2.5.8 |
| `a11y.measure` | line measure at most 80ch | SC 1.4.8 |
| `type.monotonic` | adjacent type roles differ after quantisation | ours |
| `space.distinct` | adjacent spacing steps differ after rounding | ours |
| `rhythm.baseline` | every line box is a whole number of baselines | ours |
| `motion.reduced` | positional motion reduces to a cross-fade | WCAG 2.3.3, WebKit |

Two layers, with different jobs:

- **The axis** makes an illegal colour *unaddressable*. Both hue axes are built
  by rendering every candidate across every lightness and chroma a role can be
  solved to, and discarding any that lands out of band. There is no integer you
  can pass that reaches violet, so `brand.hue` and `brand.warm` never fire
  during normal composition. That is the stronger property: illegal states are
  unrepresentable, not merely rejected.
- **The gate** is defence in depth for everything that arrives another way: an
  explicit pin, a hand-written override, a future contributor. The demo and the
  tests prove it bites, by pinning an illegal hue directly.

Both layers were earned rather than designed in. Filtering the axis at a single
lightness left a boundary hue whose own `accent-quiet` role rendered at 75.6
degrees and got refused by a rule the axis had just said it satisfied. There is
a regression test for exactly that.

### The contrast decision, stated plainly

The gate is **WCAG 2.2**, not APCA. Two reasons:

1. WCAG 2.x is the only contrast maths with legal force (EN 301 549, Section 508,
   the EAA). APCA is normative nowhere: it was removed from the WCAG 3 draft in
   July 2023, and the April 2026 WCAG 3 Editor's Draft still says the contrast
   algorithm is "yet to be determined".
2. The `apca-w3` reference implementation ships under a "Limited W3 License" with
   patents pending and restricted naming. That is not a licence this repo can
   take, and reimplementing the constants does not clear the patent claim.

Oklab lightness separation is reported alongside as an advisory signal, because
the WCAG ratio genuinely is poor at discriminating dark-on-dark pairs. It is
never called contrast and never gates anything.

---

## A finding for BRAND.md

`bun run demo.ts` includes this case, and it is a finding rather than a bug.

With the warm profile off, an accent at OKLCH hue 300 is **admitted** as
`#865bc5`, whose rendered hue is 264.3 degrees. That colour is violet to anyone
looking at it. It passes because BRAND.md states the banned band as **270-350**,
and 264 is below 270. The blue-violet region most people call purple starts
nearer 255.

This is **not** silently widened here. Changing a brand rule is a doctrine
decision, not a decision for the code that enforces it. `BANNED_HUE_MIN` in
`axes.ts` is a single named constant, so the fix is one line once the band is
agreed. The warm profile, which is on by default, refuses this colour today.

**Recommendation: widen the lower bound to 255.**

---

## Wiring hook

This package does **not** edit `packages/daemon/table-routes.ts`. Other agents
are working in that file and a design substrate is not worth a merge conflict in
the live mention flow. The hook is four lines, in the same seam
`packages/verify` uses: after the officer's reply is generated, before
`store.postMessage`.

In `runMentionFlow`, at the line that currently reads
`const proposal = parseProposal(reply);` (around line 740):

```ts
import { renderDesignMarkers, OFFICER_DESIGN_PROMPT } from "@8gent/design-compose";

// ... inside runMentionFlow, immediately before parseProposal:
const design = renderDesignMarkers(reply, { ledger });
const withDesign = design.handled ? design.text : reply;

const proposal = parseProposal(withDesign);
let outgoing = withDesign;
```

And append `OFFICER_DESIGN_PROMPT` to the officer system prompt beside the
existing `[[TASK]]` instructions, the same way `OFFICER_CLAIM_PROMPT` is added.

Ordering note: run the design pass **before** `parseProposal`, so an officer can
emit a design and a task in one reply and both are handled. The design pass only
touches its own markers and returns the input unchanged when there are none.

Ledger: this package never opens a ledger. The caller injects one, so the daemon
stays the single writer. It appends `design.composed` and `design.refused`, and
the composed entry carries the full token set, so any design can be rebuilt from
the ledger without re-running the composer.

---

## What this does NOT do

Written plainly, because the philosophy layer is genuinely thinner than the token
layer and dressing that up would be worse than saying it.

- **There is no published metric for "hierarchy strength."** Nothing in
  computational aesthetics defines one, and the circulating rules of thumb
  ("below 1.125 hierarchy becomes ambiguous") are blogs and tool marketing with
  no cited experiment. The definition in `score.ts` is **ours**. It is stated
  precisely so it can be argued with. It is not a finding.

- **The restraint score rests on weak validation.** Ngo's economy measure
  `ECM = 1 / n_size` is real and published, but its validation is two
  experiments, six greyscale layouts on an overhead projector, no correlation
  coefficient reported, and the authors themselves flag both load-bearing
  assumptions as unjustified. Reinecke's CHI 2013 complexity model is far
  stronger (R-squared .65 with published coefficients) but it operates on
  rendered **screenshots**, not token specs, so it cannot be applied without a
  rendering step. That is real future work, not something faked here.

- **The rhythm score is a conformance count, not insight.** Because
  `assertBaselineRhythm` already refuses anything off the baseline, the type
  half of that score is 1.0 for every spec that gets through. It earns its keep
  only on the spacing ramp, which is not gated.

- **No spatial reasoning at all.** This composes a token system and a layout
  skeleton. It does not place elements, does not compute balance or visual
  weight, and cannot tell you whether a particular screen is well composed. The
  Gestalt work that would support that (Desolneux's a contrario grouping, the
  Kubovy Pure Distance Law) is fully specified in the literature and entirely
  unimplemented here.

- **No optical correction.** Overshoot, optical centering and side bearings are
  craft with no published metric for arbitrary forms. Tracking is a fixed table
  copied from Material 3's hand-tuned values, not a formula.

- **Not DTCG-conformant.** The output shape is aligned with the Design Tokens
  Community Group's `{value, unit}` and `$type` vocabulary but carries no
  `$schema` and makes no conformance claim. The current draft (Format Module
  2025.10) carries an explicit banner reading "do not implement anything in this
  document", and its colour and dimension shapes have already changed
  incompatibly once. Emitting a `$schema` we cannot honour would be worse than
  emitting none.

- **The five tones are a closed set.** An open-ended adjective would push
  interpretation back into the model, which is the cost this package exists to
  remove. That is a deliberate limit, but it is a limit.

- **The scorer's weights are a judgement call** and are not derived from
  anything.

---

## Sources

Values transcribed from primary sources, cited at the constant in each file.

- Oklab and OKLCH: Björn Ottosson, *A perceptual color space for image processing*
- Gamut mapping, transfer functions, deltaEOK: CSS Color Module Level 4 (W3C)
- Contrast and conformance: WCAG 2.2 (W3C Recommendation)
- Type-scale recurrence and motion tokens: IBM Carbon (`packages/type`, `packages/motion`)
- Fluid type `clamp()` and the SC 1.4.4 check: Utopia (`@trys/utopia-core`)
- Type scale, springs, shape tokens: Material 3 (`androidx.compose.material3.tokens`)
- Layout primitives: Every Layout (Heydon Pickering, Andy Bell)
- Reduced motion: WebKit *Responsive Design for Motion*, MDN, WCAG SC 2.3.3
- Economy and simplicity measures: Ngo and Byrne (2001), *IJAMCS* 11(2)
- Grid construction: Müller-Brockmann, *Grid Systems in Graphic Design*
