/**
 * HTTP Client - fetch wrapper with timeout, retries, JSON parsing,
 * error handling, and request logging.
 *
 * Zero dependencies beyond the runtime fetch API.
 */

export interface HttpClientOptions {
  /** Base URL prepended to all requests */
  baseUrl?: string;
  /** Default timeout in ms (default: 10_000) */
  timeout?: number;
  /** Max retry attempts on failure (default: 2) */
  retries?: number;
  /** Delay between retries in ms - doubled each attempt (default: 500) */
  retryDelay?: number;
  /** Default headers merged into every request */
  headers?: Record<string, string>;
  /** Called on every request/response for observability */
  logger?: (entry: RequestLog) => void;
}

export interface RequestLog {
  method: string;
  url: string;
  status: number | null;
  durationMs: number;
  attempt: number;
  error?: string;
}

export class HttpClientError extends Error {
  constructor(
    message: string,
    public status: number,
    public body: string,
  ) {
    super(message);
    this.name = "HttpClientError";
  }
}

const defaults: Required<Omit<HttpClientOptions, "baseUrl" | "logger">> = {
  timeout: 10_000,
  retries: 2,
  retryDelay: 500,
  headers: { "Accept": "application/json" },
};

export class HttpClient {
  private opts: HttpClientOptions;

  constructor(opts: HttpClientOptions = {}) {
    this.opts = { ...opts };
  }

  /** Core request method with timeout, retries, and logging. */
  async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<T> {
    const url = this.opts.baseUrl ? `${this.opts.baseUrl}${path}` : path;
    const maxAttempts = (this.opts.retries ?? defaults.retries) + 1;
    const baseDelay = this.opts.retryDelay ?? defaults.retryDelay;
    const timeout = this.opts.timeout ?? defaults.timeout;

    const headers: Record<string, string> = {
      ...defaults.headers,
      ...this.opts.headers,
      ...extraHeaders,
    };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const start = performance.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);

      let status: number | null = null;
      try {
        const res = await fetch(url, {
          method,
          headers,
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: controller.signal,
        });
        status = res.status;

        const text = await res.text();
        this.log({ method, url, status, durationMs: performance.now() - start, attempt });

        if (!res.ok) {
          throw new HttpClientError(`${method} ${path} returned ${status}`, status, text);
        }

        // Return parsed JSON if content exists, otherwise return empty
        if (!text) return undefined as T;
        try {
          return JSON.parse(text) as T;
        } catch {
          return text as T;
        }
      } catch (err: unknown) {
        const duration = performance.now() - start;
        const message = err instanceof Error ? err.message : String(err);
        this.log({ method, url, status, durationMs: duration, attempt, error: message });

        lastError = err instanceof Error ? err : new Error(message);

        // Don't retry client errors (4xx) - only retry on network/timeout/5xx
        if (err instanceof HttpClientError && err.status >= 400 && err.status < 500) {
          throw err;
        }

        if (attempt < maxAttempts) {
          await sleep(baseDelay * Math.pow(2, attempt - 1));
        }
      } finally {
        clearTimeout(timer);
      }
    }

    throw lastError ?? new Error(`${method} ${path} failed after ${maxAttempts} attempts`);
  }

  get<T = unknown>(path: string, headers?: Record<string, string>) {
    return this.request<T>("GET", path, undefined, headers);
  }

  post<T = unknown>(path: string, body?: unknown, headers?: Record<string, string>) {
    return this.request<T>("POST", path, body, headers);
  }

  put<T = unknown>(path: string, body?: unknown, headers?: Record<string, string>) {
    return this.request<T>("PUT", path, body, headers);
  }

  del<T = unknown>(path: string, headers?: Record<string, string>) {
    return this.request<T>("DELETE", path, undefined, headers);
  }

  private log(entry: RequestLog) {
    this.opts.logger?.(entry);
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
