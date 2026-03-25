# csv-parser

## Tool Name
csv-parser

## Description
Bidirectional CSV utility. Parses CSV strings into arrays or header-keyed objects, and generates valid CSV from arrays or objects. Handles RFC 4180 quoted fields, embedded newlines, escaped double-quotes, and configurable delimiters.

## Status
quarantine

## Exports
- `parseCSV(input, options?)` - parse a CSV string to `string[][]` or `Record<string, string>[]`
- `generateCSV(data, headers?, options?)` - serialize arrays or objects to CSV

## Integration Path
1. **Review** - verify edge cases: multi-char delimiters, BOM, Windows line endings.
2. **Test** - add `packages/tools/csv-parser.test.ts` with unit cases.
3. **Register** - add to `packages/eight/tools.ts` as `tool("csv_parse", ...)` and `tool("csv_generate", ...)`.
4. **Permissions** - no filesystem or network access required; no policy entry needed.
5. **Promote** - remove quarantine tag once tests pass and tool is wired into the agent loop.
