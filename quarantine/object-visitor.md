# Quarantine: object-visitor

**Status:** quarantine - not yet wired into any agent or package index.

## What it does

Recursive object walker with enter/leave visitor hooks, deep value transformation, and predicate-based collection.

## API

### `visit(obj, visitor)`

Walk any object or array recursively. The `visitor` may define:

- `enter(key, value, path)` - called before descending into a node. Return `"skip"` to skip children, `"stop"` to abort the entire traversal.
- `leave(key, value, path)` - called after all children have been visited.

```ts
import { visit } from "./packages/tools/object-visitor.ts";

visit({ a: { b: 1 }, c: [2, 3] }, {
  enter(key, value, path) {
    console.log(path.join("."), "->", value);
  },
});
```

### `transform(obj, fn)`

Returns a deep clone of `obj` with every leaf value replaced by `fn(leaf, path)`. Arrays and plain objects are recursed into; everything else is a leaf.

```ts
import { transform } from "./packages/tools/object-visitor.ts";

const doubled = transform({ a: 1, b: { c: 2 } }, (v) =>
  typeof v === "number" ? v * 2 : v
);
// { a: 2, b: { c: 4 } }
```

### `collect(obj, predicate)`

Walk `obj` and return an array of all values (leaf or node) for which `predicate` returns true.

```ts
import { collect } from "./packages/tools/object-visitor.ts";

const strings = collect({ a: "hello", b: 42, c: { d: "world" } },
  (v) => typeof v === "string"
);
// ["hello", "world"]
```

## Skip / Stop controls

Return `"skip"` from `enter` to skip a subtree without stopping traversal. Return `"stop"` to abort immediately.

```ts
visit(largeObject, {
  enter(key, value, path) {
    if (key === "secrets") return "skip";  // don't descend into secrets
    if (path.length > 10) return "stop";   // bail out on deep nesting
  },
});
```

## Promotion checklist

- [ ] Unit tests added in `packages/tools/object-visitor.test.ts`
- [ ] Edge cases covered: circular refs, `null`, `undefined`, `Date`, `Map`, `Set`
- [ ] Exported from `packages/tools/index.ts` (or similar barrel)
- [ ] Used by at least one consumer (agent, harness, or pipeline)
- [ ] Reviewed for safety: no eval, no dynamic `require`, no prototype pollution
