# debounce-throttle

## Tool Name
debounce-throttle

## Description
Debounce and throttle utilities for controlling function execution rate. Debounce delays invocation until after a quiet period; throttle limits invocation to at most once per interval. Both support leading/trailing edge firing, cancel to drop pending calls, and flush to invoke immediately.

## Status
quarantine

## Integration Path
- **Package:** `packages/tools/debounce-throttle.ts`
- **Exports:** `debounce(fn, ms, options?)`, `throttle(fn, ms, options?)`
- **Use cases:**
  - Debounce user input handlers (search, resize, scroll) in TUI/CLUI
  - Throttle polling loops in `packages/proactive/` or `packages/memory/`
  - Rate-limit outbound API calls in any provider package
- **Wire-up:** Import directly where needed - no registration required. Candidate for inclusion in `packages/tools/index.ts` once validated.
