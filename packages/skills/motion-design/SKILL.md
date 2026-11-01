---
name: motion-design
description: 8gent's animation and motion rules for web and TUI. Apply when adding transitions, loading states, or interactive feedback to any interface.
type: skill
---

# Motion Design

Motion is communication. When done right, it's invisible — users just feel like the interface understands them.

## Purpose Order

1. **Feedback** - Confirm an action happened (click, submit, error)
2. **Orientation** - Show where something came from or is going
3. **Delight** - Add personality to moments that deserve it

Never animate just because you can.

## Timing

| Type | Duration | Use |
|------|----------|-----|
| Micro-interaction | 100-150ms | Hover, focus, toggle, button press |
| Standard transition | 200-300ms | Modal open/close, menu, navigation |
| Entrance / complex | 300-500ms | Page transitions, staggered lists |

Rules:
- Feedback must be under 200ms — anything slower feels broken.
- Never exceed 500ms for a single animation.
- Small elements animate faster than large surfaces.
- Stagger grouped elements (50ms between children).

## Easing

| Curve | When |
|-------|------|
| ease-out | Entrances — arrives fast, settles gently |
| ease-in | Exits — builds momentum before leaving |
| ease-in-out | Panel slides, drawer moves |
| spring | Organic moments (sparingly) |

Never use `linear` for UI motion — it feels mechanical.

## Terminal-Specific Patterns

- **Cursor blink**: Standard terminal rate (530ms on/off). Don't override unless showing custom state.
- **Text fade-in**: Opacity 0 -> 1 at 150ms for arriving content. Keeps the terminal feel without harsh pops.
- **Progressive reveal**: Stream text or list items one at a time instead of all-at-once. Faster perceived response.
- **Spinner frames**: 80-100ms per frame for a smooth feel. Use Unicode block characters for smooth animation.
- **Status transitions**: Dim old status, pause 50ms, show new status. Prevents jarring state jumps.

## What to Animate

Good candidates:
- State changes: open/close, selected/unselected, on/off
- Entrances and exits: modals, menus, notifications, new list items
- Feedback: button press, form submission, error shake
- Loading: skeleton screens, progress bars, spinners

Skip animation for:
- High-frequency actions (context menus, tooltips that repeat)
- Large amounts of content (50 list items animating is noise)
- User-initiated instant actions (typing)
- Anything that delays task completion

## Performance

- Animate only `transform` and `opacity` — compositor properties only.
- Never animate `width`, `height`, `top`, `left`, `margin`, `padding` on large elements.
- Max 3 concurrent animations. More than that is visual noise.
- Test on low-powered devices and reduced-motion settings.

## Accessibility (MANDATORY)

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
  }
}
```

- Never use motion as the only way to convey information.
- Pause looping animations when off-screen.

## Animation Budget

| Budget item | Limit |
|-------------|-------|
| Concurrent animations | 3 max |
| Single animation duration | 500ms max |
| Stagger delay per child | 50ms |
| Feedback latency | 200ms max |

## Checklist

- [ ] Does this animation serve feedback, orientation, or delight?
- [ ] Duration is under 500ms
- [ ] Entrances use ease-out
- [ ] Only transform/opacity animated
- [ ] prefers-reduced-motion handled
- [ ] Tested at 60fps on target device
