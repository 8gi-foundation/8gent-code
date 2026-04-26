/**
 * API Client Entry Point
 */

import { ApiClient } from "./client";
import { PostsApi } from "./posts";
import type { ApiConfig } from "./types";
import { UsersApi } from "./users";

export function createApi(config: ApiConfig) {
	const client = new ApiClient(config);

	return {
		users: new UsersApi(client),
		posts: new PostsApi(client),
	};
}

export * from "./types";
