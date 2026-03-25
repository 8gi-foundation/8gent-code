# quarantine: toml-parser

## Tool Name
`toml-parser`

## Description
Zero-dependency TOML config file parser. Converts TOML input strings into plain JavaScript objects. Handles the full TOML data model: standard tables, array of tables (`[[key]]`), inline tables, arrays, quoted/triple-quoted strings, integers (decimal, hex, octal, binary), floats, booleans, and ISO 8601 dates.

## Status
**quarantine** - self-contained, not wired into the agent tool registry yet.

## Integration Path
1. Register in `packages/eight/tools.ts` as a `read_config` or `parse_toml` tool.
2. Use in `packages/permissions/policy-engine.ts` to support TOML-format policy files alongside YAML.
3. Use in the config loader for any package that currently parses `.toml` files manually.
4. Expose via agent CLI: `bun -e "import {parseTOML} from './packages/tools/toml-parser.ts'; console.log(parseTOML(await Bun.file('config.toml').text()))"`.

## API
```ts
import { parseTOML } from "./packages/tools/toml-parser.ts";

const config = parseTOML(`
[server]
host = "localhost"
port = 8080
debug = true

[[users]]
name = "Alice"
role = "admin"
`);
// { server: { host: "localhost", port: 8080, debug: true }, users: [{ name: "Alice", role: "admin" }] }
```

## Constraints
- No external dependencies.
- 80-150 lines of TypeScript.
- Does not cover multi-line arrays with mixed comment lines (edge case, deferred).
