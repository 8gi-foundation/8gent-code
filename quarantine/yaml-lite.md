# Quarantine: yaml-lite

**Status:** quarantine - unreviewed, not wired into any index

**File:** `packages/tools/yaml-lite.ts`

---

## What it does

Zero-dependency YAML parser and stringifier. Handles the subset of YAML that shows up in real codebases: config files, policy definitions, prompt templates, training data manifests.

| Function | Signature | Description |
|----------|-----------|-------------|
| `parseYaml` | `(input: string) => YamlValue` | Parse a YAML string into a JS value. |
| `stringifyYaml` | `(value: YamlValue) => string` | Stringify a JS value to YAML. |

`YamlValue` type:

```ts
type YamlValue =
  | string
  | number
  | boolean
  | null
  | YamlValue[]
  | { [key: string]: YamlValue };
```

---

## Features

| Feature | Support |
|---------|---------|
| Key-value pairs | flat and nested |
| Comments | `# inline and full-line` |
| Block sequences | `- item` |
| Inline arrays | `[a, b, c]` |
| Inline mappings | `{k: v, k2: v2}` |
| Literal block scalars | `\|` preserves newlines |
| Folded block scalars | `>` folds newlines to spaces |
| String scalars | plain, single-quoted, double-quoted |
| Numeric scalars | integer, float, hex `0x`, octal `0o` |
| Boolean scalars | `true/false/True/False/TRUE/FALSE` |
| Null scalars | `null/Null/NULL/~` |
| Special floats | `.inf/-.inf/.nan` |
| Document markers | `---` and `...` stripped silently |

---

## Limitations (by design - zero deps)

- No anchors/aliases (`&anchor`, `*alias`)
- No tags (`!!str`, `!!int`)
- No multi-document streams
- Inline arrays of scalars only (no nested objects inside `[...]`)
- No merge keys (`<<: *defaults`)

These cover roughly 95% of real config YAML. For full spec compliance use `js-yaml`.

---

## CLI usage

```bash
# Parse YAML from argument
bun packages/tools/yaml-lite.ts parse "key: value"

# Parse from stdin
echo 'name: eight
version: "1.0.0"
features:
  - memory
  - evolution' | bun packages/tools/yaml-lite.ts parse

# Stringify JSON to YAML
echo '{"name":"eight","tags":["agent","local"]}' | bun packages/tools/yaml-lite.ts stringify
```

---

## Example round-trip

Input YAML:

```yaml
# Agent config
name: eight
version: 1
debug: false
tags:
  - agent
  - local
model:
  provider: ollama
  name: qwen3.5
notes: |
  Runs locally.
  No API key needed.
```

Output from `parseYaml`:

```json
{
  "name": "eight",
  "version": 1,
  "debug": false,
  "tags": ["agent", "local"],
  "model": {
    "provider": "ollama",
    "name": "qwen3.5"
  },
  "notes": "Runs locally.\nNo API key needed.\n"
}
```

---

## Implementation notes

- No external dependencies. Pure TypeScript string/character operations.
- Recursive descent parser. `ParseContext` carries `lines[]` and `pos` cursor.
- `findMappingColon()` respects quoted strings when locating `:` separators.
- Block scalar collection determines indentation from the first non-blank line.
- `stringifyYaml` emits literal block scalars for strings containing newlines.
- `shouldQuote()` is conservative - prefers quoting over silent type coercion.

---

## Integration notes

Not wired into `packages/tools/index.ts` or any agent tool registry. Export and register when needed.

Potential uses:
- `packages/permissions/policy-engine.ts` - parse NemoClaw YAML policy files
- `packages/self-autonomy/` - serialize/deserialize evolution checkpoints
- `packages/kernel/` - training config parsing (`config/training-proxy.yaml`)
- `packages/eight/agent.ts` - agent config file loading
