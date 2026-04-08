/**
 * Minimal HTTP client wrapping fetch with retry, timeout, typed responses,
 * and request/response interceptors.
 */

export interface HttpClientOptions {
  baseUrl?: string;
  timeout?: number;
  retries?: number;
  retryDelay?: number;
  headers?: Record<string, string>;
}

export interface RequestOptions {
  headers?: Record<string, string>;
  timeout?: number;
  retries?: number;
  params?: Record<string, string>;
}

export interface HttpResponse<T = unknown> {
  data: T;
  status: number;
  headers: Headers;
  ok: boolean;
}

export type RequestInterceptor = (
  url: string,
  init: RequestInit
) => [string, RequestInit] | Promise<[string, RequestInit]>;

export type ResponseInterceptor = (
  response: Response
) => Response | Promise<Response>;

export class HttpClientError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly body?: unknown
  ) {
    super(message);
    this.name = "HttpClientError";
  }
}

export class HttpClient {
  private baseUrl: string;
  private defaultTimeout: number;
  private defaultRetries: number;
  private retryDelay: number;
  private defaultHeaders: Record<string, string>;
  private requestInterceptors: RequestInterceptor[] = [];
  private responseInterceptors: ResponseInterceptor[] = [];

  constructor(options: HttpClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? "";
    this.defaultTimeout = options.timeout ?? 10_000;
    this.defaultRetries = options.retries ?? 3;
    this.retryDelay = options.retryDelay ?? 500;
    this.defaultHeaders = {
      "Content-Type": "application/json",
      ...options.headers,
    };
  }

  addRequestInterceptor(fn: RequestInterceptor): void {
    this.requestInterceptors.push(fn);
  }

  addResponseInterceptor(fn: ResponseInterceptor): void {
    this.responseInterceptors.push(fn);
  }

  private buildUrl(path: string, params?: Record<string, string>): string {
    const url = path.startsWith("http") ? path : `${this.baseUrl}${path}`;
    if (!params || Object.keys(params).length === 0) return url;
    return `${url}?${new URLSearchParams(params).toString()}`;
  }

  private async fetchWithTimeout(
    url: string,
    init: RequestInit,
    timeout: number
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    opts: RequestOptions = {}
  ): Promise<HttpResponse<T>> {
    let url = this.buildUrl(path, opts.params);
    let init: RequestInit = {
      method,
      headers: { ...this.defaultHeaders, ...opts.headers },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    };

    for (const interceptor of this.requestInterceptors) {
      [url, init] = await interceptor(url, init);
    }

    const timeout = opts.timeout ?? this.defaultTimeout;
    const retries = opts.retries ?? this.defaultRetries;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        let response = await this.fetchWithTimeout(url, init, timeout);

        for (const interceptor of this.responseInterceptors) {
          response = await interceptor(response);
        }

        if (!response.ok) {
          let errorBody: unknown;
          try { errorBody = await response.json(); } catch { /* ignore */ }
          throw new HttpClientError(
            `HTTP ${response.status} ${response.statusText}`,
            response.status,
            errorBody
          );
        }

        const ct = response.headers.get("content-type") ?? "";
        const data: T = ct.includes("application/json")
          ? (await response.json()) as T
          : (await response.text()) as unknown as T;

        return { data, status: response.status, headers: response.headers, ok: true };
      } catch (err) {
        lastError = err as Error;
        const isRetryable =
          !(err instanceof HttpClientError) ||
          (err.status !== undefined && err.status >= 500);
        if (attempt < retries && isRetryable) {
          await new Promise(r => setTimeout(r, this.retryDelay * 2 ** attempt));
          continue;
        }
        throw err;
      }
    }

    throw lastError;
  }

  get<T>(path: string, opts?: RequestOptions): Promise<HttpResponse<T>> {
    return this.request<T>("GET", path, undefined, opts);
  }

  post<T>(path: string, body?: unknown, opts?: RequestOptions): Promise<HttpResponse<T>> {
    return this.request<T>("POST", path, body, opts);
  }

  put<T>(path: string, body?: unknown, opts?: RequestOptions): Promise<HttpResponse<T>> {
    return this.request<T>("PUT", path, body, opts);
  }

  delete<T>(path: string, opts?: RequestOptions): Promise<HttpResponse<T>> {
    return this.request<T>("DELETE", path, undefined, opts);
  }
}

export const httpClient = new HttpClient();
