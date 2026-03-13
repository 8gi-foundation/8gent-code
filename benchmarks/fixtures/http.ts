/**
 * Minimal HTTP server abstraction fixture for full-stack benchmarks.
 * Provides a Router + request/response types the LLM must build on.
 */

export interface HttpRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: any;
  /** Attached by middleware */
  user?: { id: string; email: string; name: string } | null;
  /** Generic context bag for middleware to pass data */
  ctx: Record<string, any>;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: any;
}

export type Handler = (req: HttpRequest) => HttpResponse | Promise<HttpResponse>;
export type Middleware = (
  req: HttpRequest,
  next: () => HttpResponse | Promise<HttpResponse>
) => HttpResponse | Promise<HttpResponse>;

export class Router {
  private routes: { method: string; path: string; handler: Handler }[] = [];
  private middleware: Middleware[] = [];

  use(mw: Middleware): void {
    this.middleware.push(mw);
  }

  get(path: string, handler: Handler): void {
    this.routes.push({ method: "GET", path, handler });
  }

  post(path: string, handler: Handler): void {
    this.routes.push({ method: "POST", path, handler });
  }

  put(path: string, handler: Handler): void {
    this.routes.push({ method: "PUT", path, handler });
  }

  delete(path: string, handler: Handler): void {
    this.routes.push({ method: "DELETE", path, handler });
  }

  async handle(req: HttpRequest): Promise<HttpResponse> {
    // Find matching route
    const route = this.routes.find(
      (r) => r.method === req.method && this.matchPath(r.path, req.path)
    );

    if (!route) {
      return { status: 404, headers: {}, body: { error: "Not found" } };
    }

    // Build middleware chain
    let index = 0;
    const chain = this.middleware;
    const handler = route.handler;

    const next = async (): Promise<HttpResponse> => {
      if (index < chain.length) {
        const mw = chain[index++];
        return mw(req, next);
      }
      return handler(req);
    };

    try {
      return await next();
    } catch (err: any) {
      return {
        status: 500,
        headers: {},
        body: { error: err.message ?? "Internal server error" },
      };
    }
  }

  private matchPath(pattern: string, actual: string): boolean {
    // Simple path matching — supports :param segments
    const patternParts = pattern.split("/");
    const actualParts = actual.split("/");
    if (patternParts.length !== actualParts.length) return false;
    return patternParts.every(
      (p, i) => p.startsWith(":") || p === actualParts[i]
    );
  }

  /** Extract path params (e.g., /users/:id → { id: "123" }) */
  static extractParams(
    pattern: string,
    actual: string
  ): Record<string, string> {
    const params: Record<string, string> = {};
    const patternParts = pattern.split("/");
    const actualParts = actual.split("/");
    patternParts.forEach((p, i) => {
      if (p.startsWith(":")) {
        params[p.slice(1)] = actualParts[i];
      }
    });
    return params;
  }
}

/** Helper to create a request for testing */
export function makeRequest(
  method: string,
  path: string,
  body?: any,
  headers?: Record<string, string>
): HttpRequest {
  return {
    method,
    path,
    headers: headers ?? {},
    body: body ?? null,
    ctx: {},
  };
}
