---
name: clone-react
description: 8gent's component extraction workflow. Apply when recreating a UI component from a screenshot, website, or design reference.
type: skill
---

# Clone React

Cloning is reverse-engineering design decisions, not copying code. Understand why something works before rebuilding it.

## The 5-Step Workflow

### Step 1 - Screenshot and Describe

Before touching any code, analyze the target:
- What is the visual hierarchy?
- What spacing system is in use? (4px? 8px? Custom?)
- What are the color relationships?
- What typography scale is visible?
- What interaction states exist? (hover, focus, active, disabled)

Write this down before building. If you can't articulate why something works, you're not ready to build it.

### Step 2 - Identify Design Tokens

Map what you see to values:

| Observed | Token candidate |
|----------|----------------|
| Padding ~24px | `spacing.lg` (24px on 8px grid) |
| Font ~14px/20px | `text-sm` or `typography.small` |
| `#1a1a1a` | Check against `colors.text.primary` |
| Subtle shadow | `shadow-sm` or `elevation.low` |
| Rounded corners ~8px | `radius.md` |

If no match exists in the design system, add the token — don't hardcode.

### Step 3 - Map to Existing Primitives

Check what already exists before building:
- `packages/skills/design-excellence` tokens
- `apps/tui/src/components/primitives/` for TUI work
- Your project's component library

The best cloned component is one that uses 90% existing primitives.

### Step 4 - Build with System Components

```tsx
// Wrong - raw extraction
<div style={{ padding: '24px', borderRadius: '8px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)' }}>

// Right - system primitives
<Card padding="lg" elevation="low">
```

Rules:
- Never copy-paste CSS from DevTools. Always translate to design tokens.
- No magic numbers. Every value traces to a token.
- No inline styles except genuinely dynamic values (width from JS, etc.).
- Props typed. No `any`.

### Step 5 - Verify All States and Responsiveness

Every component must handle:
- [ ] Default state
- [ ] Hover state
- [ ] Focus state (keyboard accessible — `focus-visible`)
- [ ] Active / pressed state
- [ ] Disabled state
- [ ] Loading state (if applicable)
- [ ] Error state (if applicable)
- [ ] Empty state (if applicable)

Responsive:
- Mobile-first. Design for 375px, scale up.
- No fixed pixel widths on layout elements.
- Tables: horizontal scroll container on mobile.
- Grids: 1 col < 600px, 2 col at 768px, full grid at 960px+.

## Anti-Patterns

- **Pixel-perfect obsession** - 1px differences don't matter. Patterns do.
- **Style soup** - 50 CSS properties when 5 design tokens work.
- **Missing states** - Default state only is not a complete component.
- **Hardcoded content** - Extracted text as a string, not a prop.
- **Ignoring system** - Building from scratch when a primitive exists.
- **Wholesale CSS copy** - Never paste a block of DevTools CSS directly.

## Accessibility Requirements

- Semantic HTML: `<button>` not `<div onClick>`, `<nav>` not `<div class="nav">`
- ARIA labels for icon-only elements
- Keyboard navigable (tab order, enter/space for buttons)
- Focus visible (never `outline: none` without a replacement)

## Checklist Before Shipping the Clone

- [ ] All 5 steps completed in order
- [ ] Every value traces to a design token
- [ ] No inline styles except dynamic values
- [ ] All interaction states handled
- [ ] Semantic HTML and ARIA correct
- [ ] Keyboard navigable
- [ ] Responsive at 375px, 768px, 1440px
- [ ] Component accepts props — no hardcoded content
