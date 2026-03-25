# chalk-lite

**Tool name:** chalk-lite

**Description:**
Minimal chainable terminal color library. Zero dependencies. Self-contained single TypeScript file (~130 lines). Fluent API identical in feel to the `chalk` npm package but without the dependency weight.

Supports:
- 16 named foreground and background colors
- 256-color foreground and background (xterm palette) via `ansi256(n)` / `bgAnsi256(n)`
- True-color 24-bit RGB via `rgb(r,g,b)` / `bgRgb(r,g,b)` with automatic downgrade to 256-color on lower-capability terminals
- Style modifiers: bold, dim, italic, underline, inverse, strikethrough
- Auto-detection of color support level (0=none, 1=16, 2=256, 3=truecolor) via `TERM`, `COLORTERM`, `NO_COLOR`, `FORCE_COLOR` environment variables
- Chainable API via ES Proxy: `chalk.bold.red('error')`, `chalk.rgb(255,165,0)('warning')`

**Status:** quarantine

Quarantine means: the tool is built and passes a manual smoke test but has not been wired into any consumer package. No agent or TUI component imports it yet. Isolated here for review before promotion.

**Integration path:**

1. Review API surface against all color uses in `apps/tui/`.
2. Audit existing ad-hoc ANSI strings in `packages/tools/` output formatters.
3. Replace ad-hoc ANSI sequences with `chalk-lite` calls.
4. Wire as optional formatter in `packages/eight/tools.ts` for tool result display.
5. Promote to `packages/tools/index.ts` export once at least one consumer is live and tested.
6. Benchmark: render 1000 colored strings, measure throughput vs raw ANSI string concat.

**Files:**
- `packages/tools/chalk-lite.ts` - implementation
- `quarantine/chalk-lite.md` - this document
