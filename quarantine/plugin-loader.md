# Quarantine: plugin-loader

**Status:** quarantine - not wired into agent yet
**Package:** `packages/tools/plugin-loader.ts`
**Branch:** `quarantine/plugin-loader`

## What it does

Dynamic plugin loading with full lifecycle management. Lets any agent or tool
package register capability plugins at runtime, init them on demand, and tear
them down cleanly.

## API surface

```ts
import { PluginLoader, Plugin } from "./packages/tools/plugin-loader";

const loader = new PluginLoader();

// Register a plugin (does not init yet)
loader.register({ name: "myPlugin", version: "1.0.0", init, destroy, provides: ["feature-x"] });

// Load (calls init)
await loader.load("myPlugin");

// Query
loader.listLoaded();                   // ["myPlugin"]
loader.getPlugin("myPlugin");          // Plugin instance
loader.findByCapability("feature-x"); // [Plugin]

// Unload (calls destroy)
await loader.unload("myPlugin");

// Convenience: register + load in one call
await loader.registerAndLoad(plugin);

// Teardown all in LIFO order, collects errors
await loader.unloadAll();
```

## Plugin interface

```ts
interface Plugin {
  name: string;
  version: string;
  init(): Promise<void> | void;
  destroy(): Promise<void> | void;
  provides?: string[];   // optional capability strings
}
```

## Integration notes

- Designed to slot into `packages/eight/agent.ts` or tool bootstrap
- `unloadAll()` should be called on agent shutdown / session end
- `provides` is intentionally open-ended - use for capability discovery
- LIFO destroy order prevents dependency teardown race conditions
- No external deps - pure TypeScript, Bun-compatible

## What it is NOT

- Not a file-system plugin scanner (no dynamic import by path)
- Not a dependency resolver (no `requires` field yet)
- Not tied to permissions/NemoClaw - wire that in separately if needed

## Promotion criteria

- [ ] Wired into agent bootstrap in `packages/eight/agent.ts`
- [ ] At least one real plugin registered (e.g. memory, music)
- [ ] `unloadAll()` called in agent shutdown path
- [ ] Unit tests covering register, load, unload, findByCapability, unloadAll errors
