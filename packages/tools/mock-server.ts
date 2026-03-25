/**
 * Mock API Server for 8gent
 *
 * Reads route definitions from a JSON file and serves mock responses.
 * Useful for testing API integrations without hitting real endpoints.
 *
 * Route file format:
 * {
 *   "routes": [
 *     {
 *       "method": "GET",
 *       "path": "/api/users",
 *       "status": 200,
 *       "headers": { "x-custom": "value" },
 *       "body": [{ "id": 1, "name": "Alice" }],
 *       "delay": 100
 *     }
 *   ]
 * }
 */

export interface MockRoute {
  method: string;
  path: string;
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
  delay?: number;
}

export interface MockRouteFile {
  routes: MockRoute[];
}

export interface MockServerOptions {
  port?: number;
  routeFile: string;
  verbose?: boolean;
}

function matchRoute(
  routes: MockRoute[],
  method: string,
  pathname: string,
): MockRoute | null {
  return (
    routes.find(
      (r) =>
        r.method.toUpperCase() === method.toUpperCase() && r.path === pathname,
    ) ?? null
  );
}

function buildResponse(route: MockRoute): Response {
  const status = route.status ?? 200;
  const headers = new Headers(route.headers ?? {});

  if (route.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  const body =
    route.body !== undefined ? JSON.stringify(route.body) : undefined;

  return new Response(body, { status, headers });
}

function notFoundResponse(): Response {
  return new Response(JSON.stringify({ error: "no matching mock route" }), {
    status: 404,
    headers: { "content-type": "application/json" },
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function loadRoutes(filePath: string): Promise<MockRoute[]> {
  const file = Bun.file(filePath);
  const exists = await file.exists();
  if (!exists) {
    throw new Error(`Route file not found: ${filePath}`);
  }
  const data: MockRouteFile = await file.json();
  if (!Array.isArray(data.routes)) {
    throw new Error(`Invalid route file: "routes" must be an array`);
  }
  return data.routes;
}

export function startMockServer(
  routes: MockRoute[],
  options: { port?: number; verbose?: boolean } = {},
) {
  const port = options.port ?? 4040;
  const verbose = options.verbose ?? false;

  const server = Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);
      const route = matchRoute(routes, req.method, url.pathname);

      if (verbose) {
        const matched = route ? `${route.status ?? 200}` : "404";
        console.log(`${req.method} ${url.pathname} -> ${matched}`);
      }

      if (!route) {
        return notFoundResponse();
      }

      if (route.delay && route.delay > 0) {
        await sleep(route.delay);
      }

      return buildResponse(route);
    },
  });

  if (verbose) {
    console.log(`Mock server listening on http://localhost:${server.port}`);
    console.log(`Serving ${routes.length} route(s)`);
  }

  return server;
}

// CLI entry point
if (import.meta.main) {
  const args = process.argv.slice(2);
  const routeFile = args[0];

  if (!routeFile) {
    console.log("Usage: bun run packages/tools/mock-server.ts <routes.json> [--port 4040] [--verbose]");
    process.exit(1);
  }

  const portIdx = args.indexOf("--port");
  const port = portIdx !== -1 ? parseInt(args[portIdx + 1], 10) : 4040;
  const verbose = args.includes("--verbose");

  const routes = await loadRoutes(routeFile);
  startMockServer(routes, { port, verbose });
}
