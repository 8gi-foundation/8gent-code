# quarantine/request-logger

## What

WebSocket message logging middleware for the daemon gateway. Logs all messages with timestamps, session IDs, message types, and payload sizes.

## Location

`packages/daemon/request-logger.ts`

## API

### `logMessage(config, direction, sessionId, messageType, payload)`

Log a single inbound or outbound WebSocket message. Call from gateway `message` and `send` paths.

Returns a `LogEntry` object with timestamp, sessionId, direction, messageType, and payloadBytes.

### `attachBusLogger(config?)`

Subscribe to all daemon EventBus events and log them. Returns an unsubscribe function.

### Verbosity levels

| Level | Output |
|-------|--------|
| `silent` | Nothing logged |
| `minimal` | Direction + message type only |
| `normal` | Timestamp, direction, type, session ID, payload size |
| `verbose` | Normal + full JSON payload dump |

## Usage

```ts
import { logMessage, attachBusLogger } from "./request-logger";

// Attach to EventBus (call once at startup)
const detach = attachBusLogger({ verbosity: "normal" });

// Log individual WebSocket messages in gateway handlers
logMessage({ verbosity: "normal" }, "inbound", sessionId, msg.type, msg);
logMessage({ verbosity: "normal" }, "outbound", sessionId, response.type, response);

// Detach when shutting down
detach();
```

## Integration status

Quarantined. Not wired into gateway.ts yet - requires adding `logMessage` calls to `handleMessage` and `send` in the gateway. Keeping isolated until reviewed and tested.

## Dependencies

- `packages/daemon/events.ts` (EventBus, bus singleton)
- No external dependencies
