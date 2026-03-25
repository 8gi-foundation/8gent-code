# Quarantine: file-tree

**Status:** Quarantine review
**Package:** `packages/tools/file-tree.ts`
**Added:** 2026-03-25

---

## What it does

ASCII tree visualization of any directory. Single file, zero deps, Bun-native.

- Configurable depth limit (default 4, 0 = unlimited)
- Ignore patterns with glob support (`*.ext`, `prefix*`, `*suffix`, exact name)
- Default ignore list: `node_modules`, `.git`, `dist`, `build`, `.next`, `.turbo`, `coverage`
- File sizes shown next to each entry (B / K / M / G)
- ANSI color output by file type:
  - Blue: directories
  - Cyan: `.ts`, `.tsx`
  - Yellow: `.js`, `.jsx`, `.mjs`, `.cjs`, `.py`
  - Green: `.json`, `.yaml`, `.yml`, `.toml`, `.env`
  - Red: `.sh`, `.bash`, `.rs`
  - Magenta: `.html`, `.css`, `.scss`
  - Bright magenta: images/media
  - White-dim: `.md`, `.txt`
- Sort order: directories first, then files, alpha within each group
- Optional `maxPerDir` to cap entries per directory
- Hidden files opt-in (`--hidden`)
- Auto-detects TTY for color (no color when piped)

---

## API

```ts
import { generateTree } from "./packages/tools/file-tree.ts";

const result = generateTree("/path/to/dir", {
  depth: 3,           // max depth (0 = unlimited)
  ignore: ["*.test.ts", "coverage"],
  showSizes: true,
  color: false,       // force off
  showHidden: false,
  maxPerDir: 20,
});

console.log(result.tree);
// result.totalFiles  -> number
// result.totalDirs   -> number
// result.totalSize   -> bytes
// result.nodes       -> TreeNode (full AST of the tree)
```

---

## CLI

```bash
bun packages/tools/file-tree.ts [path] [options]

Options:
  --depth, -d <n>       Max depth (default: 4, 0 = unlimited)
  --no-color            Disable ANSI colors
  --hidden              Show hidden files/dirs
  --no-sizes            Hide file sizes
  --max-per-dir <n>     Max entries per directory
  --ignore <pattern>    Extra ignore pattern (repeatable)
  --help, -h            Show this help

# Examples
bun packages/tools/file-tree.ts
bun packages/tools/file-tree.ts src --depth 3
bun packages/tools/file-tree.ts . --depth 0 --no-color > tree.txt
bun packages/tools/file-tree.ts . --ignore "*.test.ts" --max-per-dir 10
```

---

## Integration notes

- Drop `generateTree()` into any agent tool that needs filesystem awareness
- The `TreeNode` type gives a full JSON-serializable AST - usable for programmatic navigation
- `totalSize` enables quick repo weight checks in CI or benchmarks
- No changes to existing files

---

## Quarantine checklist

- [x] Zero external dependencies
- [x] Does not modify any existing file
- [x] Exports `generateTree()` as documented
- [x] Has a working `--help` CLI flag
- [x] Color codes stay within brand-safe palette (no purple/pink/violet 270-350 hues)
- [x] Default ignores prevent noise from `node_modules`, `.git`, etc.
- [ ] Integration test (pending - add to `packages/tools/__tests__/file-tree.test.ts`)
- [ ] Wire into agent tool registry (`packages/tools/index.ts`) - deferred until post-review
