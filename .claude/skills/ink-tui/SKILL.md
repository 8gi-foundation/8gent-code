---
name: Ink TUI
description: Ink 6 + React terminal UI layout, borders, wrapping, and overflow. USE WHEN building or fixing 8gent-code TUI, chat bubbles, footers, Ink Box/Text layout, text on border lines, or terminal overflow.
---

# Ink + React TUI specialist (8gent-code)

Expert patterns for [Ink](https://github.com/vadimdemedes/ink) (React renderer for CLIs). Targets **Ink 6.x** and **React 19** as in `apps/tui/package.json`.

## When to load this skill

- Chat or status UI looks messy: text on the **border line**, not **inside** the box
- Long lines **spill** past the panel or **overlap** the footer / input row
- Resize leaves **ghost lines** or **misaligned** chrome (known Ink/terminal limits)
- You need a **repeatable “bubble” or card** pattern in the terminal

## 8gent-code project rules (non-negotiable)

Read **`CONVENTIONS.md`** (TUI Design System + TUI Color Rules).

- Compose from **`apps/tui/src/components/primitives/`** (`Stack`, `Inline`, `Card`, `AppText`, …). Avoid raw `<Box>` / `<Text>` in **screens**; primitives may use Ink internally.
- Width-sensitive strings: use **`apps/tui/src/lib/text`** helpers (`truncate()`, `wrapText` if present).
- **Never** `color="gray"` / `white` / `black` on text or borders (terminal theme breakage). Use semantic primitives and approved colors.

## Mental model: Ink layout

- Ink uses **Yoga (flexbox)**. Think in **`flexDirection`**, **`width`**, **`flexGrow`**, **`minHeight`**, **`padding`**, **`margin`**.
- **Borders are part of the Box.** Content is laid out in the **content box**. If text visually sits **on** the bottom or top border, you usually have **no inner padding**, **wrong nesting**, or **siblings fighting for width**.

Official examples and APIs: [Ink repo](https://github.com/vadimdemedes/ink), [border examples](https://github.com/vadimdemedes/ink/blob/master/examples/borders/borders.tsx). Overview of Ink 3+ layout: [Ink 3 post](https://vadimdemedes.com/posts/ink-3).

## Pattern A: Bordered “bubble” with text clearly inside

**Anti-pattern:** One `Box` with `borderStyle` and `Text` as a direct child with no padding, or multiple `Text` nodes that align flush to the inner edge.

**Preferred:**

```tsx
<Box
  flexDirection="column"
  width={availableWidth} // or "100%" when parent constrains
  borderStyle="round"
  borderColor="blue"
>
  <Box flexDirection="column" paddingX={1} paddingY={1}>
    <Text wrap="wrap">{content}</Text>
  </Box>
</Box>
```

Rules of thumb:

1. **Outer Box** = border + optional `marginBottom` / `marginTop`.
2. **Inner Box** = **always** set **`paddingX` and `paddingY`** (even `1`) so glyphs never touch border glyphs.
3. Put **wrapped text only inside** the inner Box. For long assistant messages, **one column** `flexDirection="column"` per bubble.

Ink 6 `Text` uses **`wrap="wrap"`** (and related props) for wrapping; confirm against your installed `ink` types if an API differs slightly.

## Pattern B: Constrain width so wrap can work

Wrapping needs a **defined width** on some ancestor:

- Pass **`width`** from **`useStdout()`** / **`useStdin()`** / **`useViewport()`** (Ink hooks) minus sidebar and padding.
- Use **`width="100%"`** on children **only if** the parent has a definite width.
- For split layouts (chat + side panel), compute **`chatWidth = columns - sideWidth - gutter`** once and thread it down.

If text still overflows horizontally, **`truncate()`** or **`wrapText`** in `apps/tui/src/lib/text` is preferred for 8gent-code consistency.

## Pattern C: Footer / status bar (no overlap with main)

**Anti-pattern:** Footer rendered in the same flex region as scrollable content without **`flexShrink={0}`** or without reserving space, so long chat output **draws through** the footer.

**Preferred:**

- **Column root:** `flexDirection="column"`, `height="100%"` (when using full terminal).
- **Main:** `flexGrow={1}`, `flexDirection="column"`, **`minHeight={0}`** (critical for flex children that scroll) + inner scrollable region if you implement manual scroll.
- **Footer / input:** **`flexShrink={0}`**, fixed **`paddingY`**, **single line** status: **`truncate`** middle or end so it never exceeds **`stdout.columns`**.

Repeat critical status tokens only once per row; avoid duplicating model name + long prose on the same physical line.

## `textWrap` / wrapping caveats (ecosystem)

Ink’s wrapping inserts line breaks for layout. That can affect **copy/paste** and **resize reflow** in edge cases; see [issue #883](https://github.com/vadimdemedes/ink/issues/883). Long unbroken strings can be problematic in nested layouts; see [issue #173](https://github.com/vadimdemedes/ink/issues/173). Prefer **explicit width**, **shorter labels**, and **truncate** for tool/status chrome.

## Debugging checklist (fast)

1. **Inner padding** on bordered panels: `paddingX` / `paddingY` > 0?
2. **Width** known end-to-end from terminal columns to `Text`?
3. **flexShrink / flexGrow** on main vs footer correct?
4. **One scroll owner** (who consumes vertical space)?
5. **Unicode / double-width** emojis: can throw column math off; test with plain ASCII.
6. **`useViewport`**: terminal resize; re-measure widths after resize.

## Deliverables when asked to “tidy” the TUI

1. Identify the **lowest Box** that owns the border; ensure an **inner padded Box** wraps all bubble text.
2. Thread **`availableWidth`** from measured columns into chat components.
3. Footer: **`flexShrink={0}`** + **truncated** single-line stats.
4. Keep changes inside **primitives/widgets** where possible per CONVENTIONS.
5. Verify at **narrow** terminal width (e.g. 80 cols) and **wide** (120+).

## References

- [vadimdemedes/ink](https://github.com/vadimdemedes/ink)
- [Ink 3 – flexbox and Text](https://vadimdemedes.com/posts/ink-3)
- [Border examples](https://github.com/vadimdemedes/ink/blob/master/examples/borders/borders.tsx)
- Wrapping / overflow discussion: [#173](https://github.com/vadimdemedes/ink/issues/173), [#883](https://github.com/vadimdemedes/ink/issues/883)
