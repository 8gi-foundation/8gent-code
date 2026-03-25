# Quarantine: usecomputer - Zig CLI for Agent Computer Control

## Source
- X: @__morse (Tommy D. Rossi, Mar 23, 2026)
- 861 likes, 72K views
- "introducing usecomputer - a CLI written in Zig to let any agent control a computer mouse & keyboard"

## Key Insights
- Zig-based CLI for mouse/keyboard control from any agent
- Handles macOS permission dialogs (our biggest pain point!)
- Works with Opus, kimaki, opencode - agent-agnostic
- Shows enabling security settings via the tool
- Cross-agent compatibility - any coding agent can use it

## Relevance to 8gent
- We built ComputerUseEngine in Lil Eight's Swift app (CGEvent based)
- Our permission handling is broken (kept asking for Screen Recording perms)
- Their Zig approach is standalone CLI - we could shell out to it instead of embedding in Swift
- Agent-agnostic = Eight, Claude Code, OpenCode, Cursor could all use it
- Could replace our CGEvent code with a `usecomputer` dependency

## What to Build
1. Find the usecomputer repo and study the Zig source
2. Create a wrapper in packages/tools/ that shells out to usecomputer
3. Compare their permission handling to our ScreenCaptureKit approach
4. If their approach is better, swap out our computer use engine
5. Add as an optional dependency - fallback to our native impl if not installed

---

## Research Findings (2026-03-25)

### Repo
- **GitHub:** github.com/remorses/usecomputer (by Tommy D. Rossi / @remorses)
- **npm:** `usecomputer` (v0.1.4)
- **License:** public repo, npm-published
- **Install:** `npm install -g usecomputer`

### Architecture
usecomputer is NOT a CLI-that-shells-out. It uses a **Zig N-API native addon** (.node file) loaded directly into Node/Bun via `createRequire`. The architecture is:

1. **Zig native layer** (`zig/src/`) - compiled to a `.node` N-API addon
   - `main.zig` - CLI entry point (also works standalone)
   - `lib.zig` - core automation: CGEvent for mouse/keyboard, ScreenCaptureKit for screenshots
   - `scroll.zig` - scroll event synthesis
   - `window.zig` - window enumeration via CGWindowListCopyWindowInfo
   - `kitty-graphics.zig` - terminal image display (Kitty protocol)
   - `table.zig` - CLI table formatting
2. **TypeScript bridge** (`src/bridge.ts`) - wraps N-API calls with Zod validation and error handling
3. **Public API** (`src/lib.ts`) - clean async functions: `screenshot()`, `click()`, `typeText()`, `press()`, `scroll()`, `drag()`, `hover()`, etc.
4. **Types** (`src/types.ts`) - full TypeScript types including `UseComputerBridge` interface

### Key Types
```ts
type Point = { x: number; y: number }
type MouseButton = 'left' | 'right' | 'middle'
type ScrollDirection = 'up' | 'down' | 'left' | 'right'
type ScreenshotResult = {
  path: string; coordMap: string; hint: string;
  captureX/Y/Width/Height: number; imageWidth/Height: number;
}
```

### Coordinate Mapping
usecomputer has a `coordMap` system - screenshots return capture geometry, and clicks can be mapped from image coordinates to screen coordinates. This handles Retina/HiDPI scaling automatically. Their `parseCoordMapOrThrow()` and `mapPointFromCoordMap()` utilities handle this.

### Platform Support
- **macOS:** Full support (CGEvent for input, ScreenCaptureKit for capture)
- **Linux:** X11 support (Wayland via XWayland)
- **Windows:** Not supported yet

### How It Compares to Our CGEvent Approach
| Aspect | usecomputer | Our CGEvent (Lil Eight) |
|--------|-------------|------------------------|
| Language | Zig N-API addon | Swift CGEvent in-process |
| Permission handling | Guides user through Accessibility prefs | Broken - kept re-prompting |
| Screenshot | ScreenCaptureKit via Zig | ScreenCaptureKit via Swift |
| Coord mapping | Built-in coordMap for HiDPI | Manual, error-prone |
| Portability | macOS + Linux | macOS only |
| Integration | npm package, import directly | Embedded in Swift app |

### Integration Built
Created `packages/tools/computer-control.ts` - a unified wrapper that:
- Dynamically imports `usecomputer` if installed (N-API path, not CLI shelling)
- Falls back to native osascript/CGEvent/screencapture on macOS
- Exposes: `click()`, `type()`, `pressKey()`, `screenshot()`, `scroll()`, `hover()`
- ~150 lines, zero required dependencies
- Any agent (Eight, Lil Eight, external) can use it

### Next Steps
- [ ] Test with `npm install -g usecomputer` on dev machine
- [ ] Wire into Eight's tool definitions (`packages/eight/tools.ts`)
- [ ] Add computer-use tool to agent's available actions
- [ ] Consider replacing Lil Eight's Swift CGEvent code with this wrapper
- [ ] Evaluate coordMap integration for screenshot-to-action pipelines
