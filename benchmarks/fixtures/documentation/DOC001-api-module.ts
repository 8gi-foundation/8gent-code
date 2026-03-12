/**
 * Fixture: DOC001 - Generate Documentation for API Module
 *
 * Task: Generate comprehensive documentation including:
 * - JSDoc comments for all public functions
 * - Type descriptions
 * - Usage examples
 * - Error handling documentation
 * - README.md for the module
 */

// No documentation - needs to be added

interface QueryParams {
  page?: number;
  limit?: number;
  sort?: string;
  order?: "asc" | "desc";
  filters?: Record<string, string | number | boolean>;
}

interface PaginatedResponse<T> {
  data: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasNext: boolean;
    hasPrev: boolean;
  };
}

interface ApiError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

type ApiResult<T> = { success: true; data: T } | { success: false; error: ApiError };

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string
  ) {
    super(message);
    this.name = "HttpError";
  }
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

function buildQueryString(params: QueryParams): string {
  const parts: string[] = [];

  if (params.page !== undefined) {
    parts.push(`page=${params.page}`);
  }
  if (params.limit !== undefined) {
    parts.push(`limit=${Math.min(params.limit, MAX_LIMIT)}`);
  }
  if (params.sort) {
    parts.push(`sort=${params.sort}`);
  }
  if (params.order) {
    parts.push(`order=${params.order}`);
  }
  if (params.filters) {
    for (const [key, value] of Object.entries(params.filters)) {
      parts.push(`${key}=${encodeURIComponent(String(value))}`);
    }
  }

  return parts.length > 0 ? `?${parts.join("&")}` : "";
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>
): Promise<T> {
  const baseUrl = process.env.API_BASE_URL || "https://api.example.com";

  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new HttpError(response.status, error.message || "Request failed", error.code);
  }

  return response.json();
}

export async function get<T>(path: string, params?: QueryParams): Promise<T> {
  const queryString = params ? buildQueryString(params) : "";
  return request<T>("GET", `${path}${queryString}`);
}

export async function post<T>(path: string, data: unknown): Promise<T> {
  return request<T>("POST", path, data);
}

export async function put<T>(path: string, data: unknown): Promise<T> {
  return request<T>("PUT", path, data);
}

export async function patch<T>(path: string, data: unknown): Promise<T> {
  return request<T>("PATCH", path, data);
}

export async function del<T>(path: string): Promise<T> {
  return request<T>("DELETE", path);
}

export async function getPaginated<T>(path: string, params?: QueryParams): Promise<PaginatedResponse<T>> {
  const queryParams = {
    page: 1,
    limit: DEFAULT_LIMIT,
    ...params,
  };
  return get<PaginatedResponse<T>>(path, queryParams);
}

export async function getAllPages<T>(
  path: string,
  params?: Omit<QueryParams, "page">
): Promise<T[]> {
  const allItems: T[] = [];
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const response = await getPaginated<T>(path, { ...params, page });
    allItems.push(...response.data);
    hasMore = response.pagination.hasNext;
    page++;
  }

  return allItems;
}

export function wrapResult<T>(promise: Promise<T>): Promise<ApiResult<T>> {
  return promise
    .then((data) => ({ success: true as const, data }))
    .catch((err) => ({
      success: false as const,
      error: {
        code: err.code || "UNKNOWN_ERROR",
        message: err.message,
        details: err.details,
      },
    }));
}

export async function batch<T>(
  requests: Array<() => Promise<T>>,
  concurrency: number = 5
): Promise<Array<ApiResult<T>>> {
  const results: Array<ApiResult<T>> = [];
  const executing: Promise<void>[] = [];

  for (const request of requests) {
    const promise = wrapResult(request()).then((result) => {
      results.push(result);
    });

    executing.push(promise);

    if (executing.length >= concurrency) {
      await Promise.race(executing);
      executing.splice(
        executing.findIndex((p) => p === promise),
        1
      );
    }
  }

  await Promise.all(executing);
  return results;
}

export { HttpError, QueryParams, PaginatedResponse, ApiError, ApiResult };
