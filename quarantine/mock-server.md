# Quarantine: Mock API Server

## What

`packages/tools/mock-server.ts` - a lightweight Bun.serve mock API server that reads route definitions from a JSON file and returns mock responses. Useful for testing API integrations without hitting real endpoints.

## Status

Quarantined - new utility, no existing files modified.

## Usage

### CLI

```bash
# Start with a routes file
bun run packages/tools/mock-server.ts routes.json --port 4040 --verbose

# Test it
curl http://localhost:4040/api/users
```

### Programmatic

```typescript
import { loadRoutes, startMockServer } from "./packages/tools/mock-server";

const routes = await loadRoutes("./test-routes.json");
const server = startMockServer(routes, { port: 4040, verbose: true });

// Later: server.stop()
```

## Route File Format

Create a JSON file with a `routes` array:

```json
{
  "routes": [
    {
      "method": "GET",
      "path": "/api/users",
      "status": 200,
      "body": [{ "id": 1, "name": "Alice" }, { "id": 2, "name": "Bob" }]
    },
    {
      "method": "POST",
      "path": "/api/users",
      "status": 201,
      "headers": { "x-request-id": "mock-123" },
      "body": { "id": 3, "name": "Created" }
    },
    {
      "method": "GET",
      "path": "/api/slow",
      "status": 200,
      "delay": 2000,
      "body": { "message": "delayed response" }
    },
    {
      "method": "DELETE",
      "path": "/api/users/1",
      "status": 204
    }
  ]
}
```

## Route Properties

| Property | Required | Default | Description |
|----------|----------|---------|-------------|
| `method` | yes | - | HTTP method (GET, POST, PUT, DELETE, etc.) |
| `path` | yes | - | Exact path to match |
| `status` | no | 200 | HTTP status code |
| `headers` | no | `{}` | Additional response headers |
| `body` | no | none | Response body (auto-serialized as JSON) |
| `delay` | no | 0 | Artificial delay in milliseconds |

## CLI Options

| Option | Default | Description |
|--------|---------|-------------|
| `<routes.json>` | (required) | Path to route definitions file |
| `--port <n>` | 4040 | Port to listen on |
| `--verbose` | off | Log each request to stdout |

## Features

- Zero dependencies - pure Bun APIs
- JSON route files - easy to version control alongside tests
- Simulated latency via `delay` - test timeout handling
- Custom headers - test CORS, auth, rate-limit headers
- Verbose mode - see request/response logs
- ~120 lines

## Integration Points

- Use in benchmark harness to mock external APIs during test runs
- Pair with `packages/tools/browser/` for end-to-end scraping tests against known HTML
- Spin up in agent tool tests to avoid flaky network calls
