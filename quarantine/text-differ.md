# text-differ

## Tool Name
`text-differ`

## Description
Myers diff algorithm for computing minimal text differences between two strings.
Supports line-level, word-level, and character-level diffs. Outputs unified diff
patches and computes edit distance.

Exports:
- `diff(a, b, options?)` - compute minimal diff edits between two texts
- `editDistance(a, b, options?)` - count of insertions + deletions
- `generatePatch(edits, options?)` - produce a unified diff string from edits

## Status
**quarantine** - implemented, not yet wired into the agent tool registry.

## Integration Path
1. Register in `packages/eight/tools.ts` as a built-in tool under the `"text-differ"` name.
2. Surface via agent as: `diff_text`, `patch_text`, `edit_distance` tool calls.
3. Useful for: code review summaries, showing what changed between file versions,
   computing similarity scores for memory deduplication.

## File
`packages/tools/text-differ.ts`
