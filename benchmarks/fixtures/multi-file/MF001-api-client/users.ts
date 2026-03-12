/**
 * Users API module - needs error handling
 */

import { ApiClient } from "./client";
import type { User, ApiResponse } from "./types";

export class UsersApi {
  private client: ApiClient;

  constructor(client: ApiClient) {
    this.client = client;
  }

  async getAll(): Promise<User[]> {
    const response = await this.client.get<User[]>("/users");
    return response.data;
  }

  async getById(id: number): Promise<User> {
    const response = await this.client.get<User>(`/users/${id}`);
    return response.data;
  }

  async create(user: Omit<User, "id">): Promise<User> {
    const response = await this.client.post<User>("/users", user);
    return response.data;
  }

  async update(id: number, user: Partial<User>): Promise<User> {
    const response = await this.client.put<User>(`/users/${id}`, user);
    return response.data;
  }

  async delete(id: number): Promise<void> {
    await this.client.delete(`/users/${id}`);
  }
}
