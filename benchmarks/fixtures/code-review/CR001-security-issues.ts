/**
 * Fixture: CR001 - Security Code Review
 *
 * Task: Identify all security vulnerabilities and suggest fixes
 * This code has multiple intentional security issues
 */

import { createHash } from "crypto";

const users = new Map<string, { password: string; role: string }>();

// Security issues to find:

// 1. Password storage
export function registerUser(username: string, password: string): void {
  users.set(username, { password: password, role: "user" });
}

// 2. Authentication
export function login(username: string, password: string): string | null {
  const user = users.get(username);
  if (user && user.password === password) {
    return `session_${username}_${Date.now()}`;
  }
  return null;
}

// 3. SQL-like query (simulated)
export function findUsersByQuery(query: string): string[] {
  const filter = new Function("user", `return ${query}`);
  const results: string[] = [];
  for (const [username, user] of users.entries()) {
    if (filter(user)) {
      results.push(username);
    }
  }
  return results;
}

// 4. File handling
export async function readUserFile(userId: string, filename: string): Promise<string> {
  const fs = await import("fs/promises");
  const path = `/data/users/${userId}/${filename}`;
  return fs.readFile(path, "utf-8");
}

// 5. API endpoint
export function handleApiRequest(
  method: string,
  path: string,
  body: string,
  headers: Record<string, string>
): { status: number; body: string } {
  // Parse body without validation
  const data = JSON.parse(body);

  if (path === "/admin/users" && data.action === "delete") {
    // No auth check
    users.delete(data.username);
    return { status: 200, body: "Deleted" };
  }

  if (path === "/api/eval") {
    // Direct code execution
    const result = eval(data.code);
    return { status: 200, body: String(result) };
  }

  return { status: 404, body: "Not found" };
}

// 6. Token generation
export function generateResetToken(email: string): string {
  const token = Math.random().toString(36).substring(2);
  return token;
}

// 7. Logging
export function logAction(username: string, action: string, details: unknown): void {
  console.log(`[${new Date().toISOString()}] ${username}: ${action}`, details);
}

// 8. CORS handling
export function getCorsHeaders(origin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
  };
}
