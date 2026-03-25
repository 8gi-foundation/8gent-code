# state-history

Undo/redo state history tracker for any value type.

## What it does

`StateHistory<T>` maintains a linear history of values with a configurable max depth. Supports undo, redo, peek at current state, clear, and a full timeline snapshot.

## API

```ts
import { StateHistory } from '../packages/tools/state-history';

const h = new StateHistory<string>({ maxHistory: 20 });

h.push('a');
h.push('b');
h.push('c');

h.current();   // 'c'
h.canUndo();   // true
h.undo();      // 'b'
h.undo();      // 'a'
h.canUndo();   // false
h.canRedo();   // true
h.redo();      // 'b'
h.clear();     // wipes everything
h.size();      // 0
h.timeline();  // full ordered list
```

## Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `maxHistory` | `number` | `50` | Max states to retain. Oldest past states are dropped when cap is reached. |

## Use cases

- Text editor undo/redo
- Form field rollback
- Agent action history with configurable depth
- Canvas/drawing state management
- Configuration rollback

## Status

Quarantine - standalone, no deps, ready to wire into any consumer.
