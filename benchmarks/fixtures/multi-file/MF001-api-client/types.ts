/**
 * Fixture: MF001 - Multi-file API Client
 *
 * Task: Add error handling and retry logic across all files
 */

export interface ApiConfig {
  baseUrl: string;
  timeout: number;
  apiKey?: string;
}

export interface ApiResponse<T> {
  data: T;
  status: number;
  headers: Record<string, string>;
}

export interface User {
  id: number;
  name: string;
  email: string;
}

export interface Post {
  id: number;
  userId: number;
  title: string;
  body: string;
}

export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";
