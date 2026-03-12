/**
 * API Client Entry Point
 */

import { ApiClient } from "./client";
import { UsersApi } from "./users";
import { PostsApi } from "./posts";
import type { ApiConfig } from "./types";

export function createApi(config: ApiConfig) {
  const client = new ApiClient(config);

  return {
    users: new UsersApi(client),
    posts: new PostsApi(client),
  };
}

export * from "./types";
