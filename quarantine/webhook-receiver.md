# Quarantine: Webhook Receiver

**Tool name:** `WebhookReceiver`
**Package:** `packages/tools/webhook-receiver.ts`
**Status:** quarantine - ready for integration review

## What it does

Lightweight HTTP server that receives and validates inbound webhooks from external
services (GitHub, Stripe, Telegram, etc.). Designed for use inside the Eight daemon
or any agent that needs to react to external push events.

| Feature | Detail |
|---------|--------|
| Transport | `Bun.serve` - zero external deps |
| Signature validation | HMAC-SHA256, constant-time comparison |
| Signature format | Raw hex or `sha256=<hex>` (GitHub style) |
| Routing | Path-based, one handler per path |
| Event queue | In-memory, configurable max size (default 1000) |
| Typed callbacks | `WebhookHandler<T>` with full event metadata |

## Files

- `packages/tools/webhook-receiver.ts` - complete implementation, ~150 lines

## Integration path (NOT done in this PR)

The receiver can be wired into the daemon or any long-running agent process:

```ts
import { WebhookReceiver } from "../tools/webhook-receiver";

const webhooks = new WebhookReceiver({ port: 18791, secret: process.env.WEBHOOK_SECRET });

webhooks
  .on({
    path: "/github",
    signatureHeader: "x-hub-signature-256",
    handler: (event) => {
      console.log("GitHub push:", event.payload);
    },
  })
  .on({
    path: "/stripe",
    secret: process.env.STRIPE_WEBHOOK_SECRET,
    handler: async (event) => {
      // handle Stripe event
    },
  })
  .start();

// On shutdown:
// webhooks.stop();
```

To wire into the daemon, add to `packages/daemon/index.ts` inside `main()`:

```ts
import { WebhookReceiver } from "../tools/webhook-receiver";
const webhooks = new WebhookReceiver({ port: 18791 });
webhooks.start();
```

## Why quarantined

- Does not modify any existing files - zero blast radius
- Integration requires wiring into daemon config and secrets management
- Port 18791 reserved for webhooks (18789 = WS gateway, 18790 = health endpoint)

## Testing

```bash
# Start receiver in isolation
bun -e "
import { WebhookReceiver } from './packages/tools/webhook-receiver.ts';
const r = new WebhookReceiver({ port: 19000, enforceSignatures: false });
r.on({ path: '/test', handler: (e) => console.log('received:', JSON.stringify(e.payload)) });
r.start();
console.log('Listening on 19000');
setTimeout(() => r.stop(), 10000);
"

# Send a test event (separate terminal)
curl -s -X POST http://localhost:19000/test \
  -H 'Content-Type: application/json' \
  -d '{"event":"test","data":{"foo":1}}'
```

Expected response:
```json
{ "received": true, "id": "1234567890-abc1234" }
```

## Constraints

- Zero external dependencies
- No modifications to existing files
- Signature enforcement is on by default - opt out with `enforceSignatures: false`
- Queue is in-memory only - events do not survive process restart
