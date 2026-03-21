---
name: design-excellence
description: 8gent's design philosophy and system. Apply when building any UI — TUI, web, or artifact. Design is intentional structure, not decoration.
type: skill
---

# Design Excellence

Design is **intentional structure**. Every element serves a purpose. Restraint creates impact.

## Core Principles

1. **Visual hierarchy first** - Guide the eye. Not everything is equally important.
2. **Restraint amplifies impact** - 3-4 colors max. 2-3 font families max. Whitespace is not wasted space.
3. **Consistency is trust** - Same patterns, same spacing, same tokens throughout.
4. **Accessibility is non-negotiable** - WCAG 2.1 AA minimum. High contrast. Keyboard navigation.

## Grid and Spacing

- Base unit: **8px** (use multiples: 4, 8, 16, 24, 32, 48, 64)
- Every element has a defined place. No arbitrary margins.
- Fixed sidebars/navigation prevent layout shifts.
- Consistent padding within components (don't mix values without reason).

```
Spacing tokens:
xs  = 4px   sm  = 8px   md = 16px
lg  = 24px  xl  = 32px  2xl = 48px  3xl = 64px
```

## Typography

- **Scale**: Display 64px / H1 48px / H2 32px / H3 24px / Body 16px / Small 14px / Tiny 12px
- At least 2x size difference between adjacent hierarchy levels.
- Line-height: 1.5-1.6 for body, tighter (1.1-1.3) for headings.
- Labels and technical data: uppercase, monospace or small caps.
- Prefer system font stack for body. Use a single display font for character.

## Color

Rules that cannot be broken:
- Max 3-4 colors in the primary palette.
- Accent color for emphasis only — not decoration.
- WCAG AA contrast ratio (4.5:1 for text, 3:1 for UI elements).
- Color must not be the only way information is conveyed.
- In terminals: never use `gray`, `white`, or `black` — use `dimColor`, semantic tokens, or safe ANSI colors.

Semantic mappings:
| Role | Use |
|------|-----|
| Primary | Brand, key actions |
| Success | green |
| Error | red |
| Warning | yellow |
| Muted | dimColor / secondary text |
| Accent | Single vibrant color, sparingly |

## Component Hierarchy

Build atoms first, compose up:
- **Atoms**: Button, Input, Badge, Icon, Text
- **Molecules**: FormField, Card, SearchBar, Alert
- **Organisms**: Header, Sidebar, DataTable, Modal

Never skip levels. A screen composes organisms. An organism composes molecules.

## Layout Patterns

- **Dashboard**: Fixed sidebar (240-320px) + flexible scrollable content
- **Data display**: Grid-based equal-height cards, consistent gutters
- **Content-heavy**: Column layout, clear typographic hierarchy

## Interaction Design

- No unexpected layout shifts. Reserve space for dynamic content.
- Smart scroll: only auto-scroll if user is within 100px of bottom.
- Keyboard shortcuts visible. Focus order logical. CMD+K for command palettes.
- All interactive states designed: default, hover, focus, active, disabled, loading, error, empty.

## Anti-Patterns

- No grid system - random spacing, no visual structure
- Too many colors - no focus, no hierarchy
- Arbitrary spacing - breaks visual rhythm
- Layout shifts on load or state change
- Cluttered density - use tabs, accordions, modals instead of cramming
- Weak contrast - if you have to squint, it fails

## Checklist Before Shipping

- [ ] 8px grid - all spacing is a multiple of 4 or 8
- [ ] Max 4 colors, max 3 font families
- [ ] WCAG AA contrast verified
- [ ] All interactive states designed (hover, focus, disabled, error, empty)
- [ ] Keyboard navigable
- [ ] No layout shifts
- [ ] Consistent tokens throughout (no magic numbers)
