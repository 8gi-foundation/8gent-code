# ast-diff

## Tool Name
`ast-diff`

## Description
Structural AST diff utility for TypeScript/JavaScript. Compares two code strings by parsing them with the TypeScript compiler API and walking their top-level declaration trees. Reports added, removed, and changed nodes (functions, classes, imports, exports, variables, interfaces, types, enums) without relying on text diffing.

Exported API:
- `diffAST(codeA: string, codeB: string): ASTDiffResult` - returns categorised diff entries with before/after signatures and a human-readable summary line.

## Status
**quarantine** - functional but not wired into the agent loop. No tests yet.

## Integration Path
1. Wire into `packages/tools/index.ts` as an exported tool.
2. Expose as an Eight tool in `packages/eight/tools.ts` so the agent can call `ast_diff` when reviewing code changes or deciding whether a patch is safe to apply.
3. Add to `packages/ast-index/` pipeline to enrich change-impact estimates with structural context (not just import-level heuristics).
4. Add unit tests under `packages/tools/__tests__/ast-diff.test.ts` covering: no changes, added function, removed import, changed class body.

## Files
- `packages/tools/ast-diff.ts` - implementation (~140 lines)
