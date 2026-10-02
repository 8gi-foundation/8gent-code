# 8DK - the 8gent Device Kit

Give a vessel a device of any kind. A device declares what it can sense and do,
a person pairs it and chooses what to allow, and each allowed capability
becomes a tool the agent can call, gated by `packages/permissions`.

Status: v1 library (#3362). The daemon `/device` WebSocket route, the TUI BODY
rail rows, saving pairings to `~/.8gent/devices/` and decision-audit entries
are follow-ups.

## Declare a device

```ts
import { defineDevice } from "@8gent/8dk";

const lamp = defineDevice(
  {
    id: "desk-lamp",
    name: "Desk lamp",
    kind: "lamp",
    version: "0.1.0",
    capabilities: [
      { name: "read_light", kind: "sensor", description: "Is the lamp on, and how bright." },
      {
        name: "set_light",
        kind: "actuator",
        description: "Turn the lamp on or off.",
        params: { on: { type: "boolean", required: true }, brightness: { type: "number" } },
      },
      { name: "strobe", kind: "actuator", description: "Flash the lamp.", confirm: true },
    ],
  },
  {
    read_light: () => ({ on: true, brightness: 60 }),
    set_light: ({ on }) => ({ on }),
    strobe: () => ({ strobed: true }),
  },
);
```

Rules: ids are lower case words joined by `-` (max 24), capability names are
lower snake case without `__` (max 30), params are `string`, `number` or
`boolean`. `confirm: true` asks the person on every call.

## Pair, grant, call

```ts
const registry = new DeviceRegistry();
const res = await registry.pair(lamp.manifest, {
  showCode: (code) => sendToDevice({ type: "device:pairing", code }),
  consent: async (req) => askThePerson(req), // { approved, grant: ["read_light"] }
});
const adapter = new DeviceToolAdapter(registry, (id) => links.get(id));
adapter.toolDefinitions();              // granted capabilities only, tools.ts shape
await adapter.execute("device__desk_lamp__read_light", {}, { agentId, sessionId, approve });
```

## Security

- Nothing is granted by default. No grant, no tool, no call.
- The person compares a 6-digit code on the device with the one in the prompt.
- Device tokens are 32 random bytes; the registry keeps only their SHA-256.
- A changed manifest fails authentication: the device pairs again.
- Every call runs `evaluatePolicy("device_use", ...)`: shadow agents are hard
  denied, and YAML `block` / `require_approval` rules can match `deviceId`,
  `capability` and `capabilityKind`.
- Revoke and unpair take effect on the next call.

## Frames

Device to vessel: `device:hello`, `device:auth`, `device:result`, `device:event`.
Vessel to device: `device:pairing`, `device:paired`, `device:invoke`, `device:revoked`.
See `link.ts`. They ride the daemon WebSocket after its auth frame
(`docs/specs/DAEMON-PROTOCOL.md`).

Concept studied from Meta's Muse Gadget SDK (Apache 2.0). No code was copied.
