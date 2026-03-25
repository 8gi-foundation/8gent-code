# Quarantine: A11y Audit Tool

## What

Static accessibility audit for 8gent TUI components. Scans `.tsx`/`.jsx` files and checks four rule categories:

1. **Color contrast** - Detects banned colors (gray, white, black) that break on certain terminal themes
2. **Interactive labels** - Verifies TextInput, SelectInput, and form elements have accessible labels
3. **Screen reader compatibility** - Flags files using raw `<Text>` with no semantic primitives (AppText, Heading, etc.)
4. **Keyboard navigation** - Checks that `useInput` handlers have matching `<ShortcutHint>` for discoverability

## Output

Returns an `A11yReport` with a 0-100 score, finding count, and per-file remediation suggestions. Errors deduct 5 points, warnings deduct 2.

## Usage

```bash
# Audit the TUI app (default target)
bun run packages/validation/a11y-audit.ts

# Audit a specific directory
bun run packages/validation/a11y-audit.ts apps/tui/src/components
```

## Programmatic API

```ts
import { auditDirectory, auditFile } from "./packages/validation/a11y-audit";

const report = await auditDirectory("apps/tui/src");
console.log(report.score);    // 0-100
console.log(report.findings); // A11yFinding[]
```

## Graduation criteria

- [ ] Run against full TUI codebase with zero false positives on a sample of 10 files
- [ ] Integrate into CI as a non-blocking check
- [ ] Add hex color contrast ratio calculation for non-ANSI color values
- [ ] Cover additional Ink interactive components if any are added

## Files

- `packages/validation/a11y-audit.ts` - audit tool (~120 lines)
- `quarantine/a11y-audit.md` - this file
