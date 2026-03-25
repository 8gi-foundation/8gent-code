# uri-template

**Tool name:** uri-template
**File:** `packages/tools/uri-template.ts`
**Status:** quarantine

## Description

RFC 6570 URI template expansion. Supports all operator types (Levels 1-4) and variable modifiers. Zero runtime dependencies.

| Export | Purpose |
|--------|---------|
| `expand(template, vars)` | Expand a URI template against a variables map |
| `parse(template)` | Tokenize a template into literals and expressions |
| `validate(template)` | Return null if valid, or an error string |

### Operator Types

| Operator | Prefix | Separator | Behavior |
|----------|--------|-----------|----------|
| (none) | - | `,` | Simple string expansion |
| `+` | - | `,` | Reserved expansion (keeps `:/?#[]@!$&'()*+,;=`) |
| `#` | `#` | `,` | Fragment expansion |
| `.` | `.` | `.` | Label expansion |
| `/` | `/` | `/` | Path segment expansion |
| `;` | `;` | `;` | Path-style parameter expansion |
| `?` | `?` | `&` | Query string expansion |
| `&` | `&` | `&` | Query string continuation |

### Variable Modifiers

| Modifier | Example | Effect |
|----------|---------|--------|
| Explode `*` | `{list*}` | Joins arrays/maps with the operator separator |
| Prefix `:N` | `{var:3}` | Truncates string value to N characters before encoding |

## Integration Path

1. **Browser tool** - `packages/tools/browser/` can use `expand` to build API endpoint URLs from route templates before fetching.
2. **Config loader** - `packages/tools/config-loader.ts` can resolve template strings in config files at load time.
3. **OpenAPI client** - Any future OpenAPI/REST client in `packages/tools/` needs RFC 6570 to expand path/query parameters from spec.
4. **Orchestration messaging** - `packages/orchestration/` filesystem messaging can use templates for dynamic file path construction.

## Dependencies

None. Pure TypeScript, zero runtime dependencies.

## Test Surface

```ts
import { expand, parse, validate } from "./packages/tools/uri-template.ts";

// Simple expansion
expand("{var}", { var: "hello" })            // "hello"
expand("{+path}", { path: "foo/bar" })       // "foo/bar"
expand("{#section}", { section: "nav" })     // "#nav"
expand("{.ext}", { ext: "json" })            // ".json"
expand("{/seg}", { seg: "api" })             // "/api"
expand("{;q}", { q: "search" })             // ";q=search"
expand("{?q,limit}", { q: "x", limit: "5" }) // "?q=x&limit=5"
expand("{&page}", { page: "2" })             // "&page=2"

// Modifiers
expand("{list*}", { list: ["a","b","c"] })   // "a,b,c"
expand("{var:3}", { var: "hello" })          // "hel"

// Validation
validate("{missing}")  // null (valid - unknown vars are just omitted)
validate("{bad name}") // "Invalid variable name: ..."
validate("{unclosed")  // "Unclosed brace in template"

// Parse
parse("https://api.example.com{/path}{?q}")
// [
//   { type: "literal", value: "https://api.example.com" },
//   { type: "expression", operator: "/", variables: [{ name: "path", ... }] },
//   { type: "expression", operator: "?", variables: [{ name: "q", ... }] },
// ]
```
