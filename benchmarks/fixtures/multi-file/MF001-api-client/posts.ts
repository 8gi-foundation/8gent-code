/**
 * Posts API module - needs error handling
 */

import type { ApiClient } from "./client";
import type { ApiResponse, Post } from "./types";

export class PostsApi {
	private client: ApiClient;

	constructor(client: ApiClient) {
		this.client = client;
	}

	async getAll(): Promise<Post[]> {
		const response = await this.client.get<Post[]>("/posts");
		return response.data;
	}

	async getById(id: number): Promise<Post> {
		const response = await this.client.get<Post>(`/posts/${id}`);
		return response.data;
	}

	async getByUser(userId: number): Promise<Post[]> {
		const response = await this.client.get<Post[]>(`/posts?userId=${userId}`);
		return response.data;
	}

	async create(post: Omit<Post, "id">): Promise<Post> {
		const response = await this.client.post<Post>("/posts", post);
		return response.data;
	}

	async update(id: number, post: Partial<Post>): Promise<Post> {
		const response = await this.client.put<Post>(`/posts/${id}`, post);
		return response.data;
	}

	async delete(id: number): Promise<void> {
		await this.client.delete(`/posts/${id}`);
	}
}
