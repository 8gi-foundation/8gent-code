/**
 * Fixture: FI002 - Add Middleware System
 *
 * Task: Implement a middleware system for the request handler
 * Requirements:
 * - Middleware functions can modify request/response
 * - Middleware can short-circuit the chain
 * - Error handling middleware
 * - Timing/logging middleware example
 */

interface Request {
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: unknown;
}

interface Response {
  status: number;
  headers: Record<string, string>;
  body?: unknown;
}

type Handler = (req: Request) => Promise<Response>;

// Current simple implementation
export class RequestHandler {
  private routes: Map<string, Handler> = new Map();

  register(method: string, path: string, handler: Handler): void {
    const key = `${method.toUpperCase()} ${path}`;
    this.routes.set(key, handler);
  }

  async handle(req: Request): Promise<Response> {
    const key = `${req.method.toUpperCase()} ${req.path}`;
    const handler = this.routes.get(key);

    if (!handler) {
      return {
        status: 404,
        headers: {},
        body: { error: "Not found" },
      };
    }

    return handler(req);
  }
}

// TODO: Implement middleware system
// type Middleware = (
//   req: Request,
//   res: Response,
//   next: () => Promise<Response>
// ) => Promise<Response>;
//
// class MiddlewareHandler extends RequestHandler {
//   use(middleware: Middleware): void;
// }
//
// Example middlewares to implement:
// - loggingMiddleware: logs request method, path, and duration
// - authMiddleware: checks for Authorization header
// - errorMiddleware: catches errors and returns 500 response
// - corsMiddleware: adds CORS headers to response
