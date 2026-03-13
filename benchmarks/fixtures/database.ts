/**
 * In-memory database fixture for full-stack benchmarks.
 * This is the "existing system" the LLM must integrate with.
 */

export interface User {
  id: string;
  email: string;
  name: string;
  passwordHash: string;
  createdAt: number;
}

export interface Session {
  token: string;
  userId: string;
  expiresAt: number;
}

export class Database {
  private users = new Map<string, User>();
  private sessions = new Map<string, Session>();
  private data = new Map<string, Map<string, any>>();

  // ── Users ───────────────────────────────────────────────────────

  createUser(user: User): User {
    if (this.users.has(user.id)) throw new Error("User already exists");
    if ([...this.users.values()].some((u) => u.email === user.email)) {
      throw new Error("Email already registered");
    }
    this.users.set(user.id, { ...user });
    return { ...user };
  }

  getUserById(id: string): User | null {
    const u = this.users.get(id);
    return u ? { ...u } : null;
  }

  getUserByEmail(email: string): User | null {
    const u = [...this.users.values()].find((u) => u.email === email);
    return u ? { ...u } : null;
  }

  // ── Sessions ────────────────────────────────────────────────────

  createSession(session: Session): Session {
    this.sessions.set(session.token, { ...session });
    return { ...session };
  }

  getSession(token: string): Session | null {
    const s = this.sessions.get(token);
    if (!s) return null;
    if (s.expiresAt < Date.now()) {
      this.sessions.delete(token);
      return null;
    }
    return { ...s };
  }

  deleteSession(token: string): boolean {
    return this.sessions.delete(token);
  }

  // ── Generic KV Collections ─────────────────────────────────────

  put(collection: string, key: string, value: any): void {
    if (!this.data.has(collection)) this.data.set(collection, new Map());
    this.data.get(collection)!.set(key, structuredClone(value));
  }

  get(collection: string, key: string): any | null {
    return structuredClone(this.data.get(collection)?.get(key) ?? null);
  }

  list(collection: string): any[] {
    const col = this.data.get(collection);
    return col ? [...col.values()].map((v) => structuredClone(v)) : [];
  }

  delete(collection: string, key: string): boolean {
    return this.data.get(collection)?.delete(key) ?? false;
  }

  // ── Utilities ───────────────────────────────────────────────────

  clear(): void {
    this.users.clear();
    this.sessions.clear();
    this.data.clear();
  }
}

/**
 * Simple hash function for passwords.
 * NOT crypto-secure — this is a test fixture.
 */
export function hashPassword(password: string): string {
  let hash = 0;
  for (let i = 0; i < password.length; i++) {
    const char = password.charCodeAt(i);
    hash = ((hash << 5) - hash + char) | 0;
  }
  return `hash_${Math.abs(hash).toString(36)}`;
}

/**
 * Generate a random ID.
 */
export function generateId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/**
 * Generate a session token.
 */
export function generateToken(): string {
  return (
    "tok_" +
    Math.random().toString(36).slice(2) +
    Math.random().toString(36).slice(2)
  );
}
