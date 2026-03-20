/**
 * @8gent/auth — GitHub Provider Token Management
 *
 * After Clerk login with GitHub social connection, this module manages
 * the GitHub OAuth token for API access. Token is stored securely
 * using the same storage backend as the main auth token (different key).
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import { decodeJwt } from "./clerk.js";
import type { TokenPayload } from "./types.js";

// ============================================
// Types
// ============================================

export interface GitHubUser {
  username: string;
  name: string;
  email: string;
  avatarUrl: string;
  profileUrl: string;
}

export interface GitHubAuth {
  /** Check if we have a cached GitHub token */
  isAuthenticated(): boolean;
  /** Get GitHub token (from cache or Clerk provider token API) */
  getToken(): Promise<string | null>;
  /** Get GitHub user profile */
  getUser(): Promise<GitHubUser | null>;
  /** Store GitHub token locally */
  storeToken(token: string): void;
  /** Clear stored token */
  clearToken(): void;
  /** Check if gh CLI is available and authenticated */
  isGhCliAvailable(): Promise<boolean>;
  /** Configure gh CLI with our token (writes to gh auth) */
  configureGhCli(token: string): Promise<boolean>;
}

// ============================================
// Storage — Platform-aware, same pattern as token-store.ts
// ============================================

const GITHUB_KEYCHAIN_SERVICE = "8gent-github";
const GITHUB_KEYCHAIN_ACCOUNT = "8gent-cli";
const GITHUB_TOKEN_FILE = "github-token.enc";
const GITHUB_KEY_SALT = "8gent-github-v1";

/** In-memory cache for the current session */
let cachedToken: string | null = null;
let cachedUser: GitHubUser | null = null;

/**
 * Store a GitHub token securely.
 * macOS: Keychain. Other: AES-256-GCM encrypted file.
 */
async function persistToken(token: string): Promise<void> {
  cachedToken = token;

  if (process.platform === "darwin") {
    await keychainStore(token);
  } else {
    fileStore(token);
  }
}

/**
 * Retrieve the stored GitHub token.
 */
async function retrieveToken(): Promise<string | null> {
  if (cachedToken) return cachedToken;

  let token: string | null = null;

  if (process.platform === "darwin") {
    token = await keychainRetrieve();
  } else {
    token = fileRetrieve();
  }

  if (token) cachedToken = token;
  return token;
}

/**
 * Clear the stored GitHub token.
 */
async function clearStoredToken(): Promise<void> {
  cachedToken = null;
  cachedUser = null;

  if (process.platform === "darwin") {
    await keychainClear();
  } else {
    fileClear();
  }
}

// ---- macOS Keychain helpers ----

async function keychainStore(token: string): Promise<void> {
  // Delete existing entry first
  await runSecurity(["delete-generic-password", "-s", GITHUB_KEYCHAIN_SERVICE, "-a", GITHUB_KEYCHAIN_ACCOUNT]).catch(() => {});

  const result = await runSecurity([
    "add-generic-password",
    "-s", GITHUB_KEYCHAIN_SERVICE,
    "-a", GITHUB_KEYCHAIN_ACCOUNT,
    "-w", token,
    "-U",
  ]);

  if (!result.success) {
    throw new Error(`Failed to store GitHub token in Keychain: ${result.stderr}`);
  }
}

async function keychainRetrieve(): Promise<string | null> {
  const result = await runSecurity([
    "find-generic-password",
    "-s", GITHUB_KEYCHAIN_SERVICE,
    "-a", GITHUB_KEYCHAIN_ACCOUNT,
    "-w",
  ]);

  if (!result.success || !result.stdout.trim()) return null;
  return result.stdout.trim();
}

async function keychainClear(): Promise<void> {
  await runSecurity([
    "delete-generic-password",
    "-s", GITHUB_KEYCHAIN_SERVICE,
    "-a", GITHUB_KEYCHAIN_ACCOUNT,
  ]).catch(() => {});
}

async function runSecurity(args: string[]): Promise<{ success: boolean; stdout: string; stderr: string }> {
  try {
    const proc = Bun.spawn(["security", ...args], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    return { success: exitCode === 0, stdout, stderr };
  } catch (error) {
    return { success: false, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
  }
}

// ---- Encrypted file helpers (Linux/CI fallback) ----

function getFilePath(): string {
  return path.join(os.homedir(), ".8gent", GITHUB_TOKEN_FILE);
}

function deriveKey(): Buffer {
  const fingerprint = `${os.hostname()}:${os.userInfo().username}`;
  return crypto.pbkdf2Sync(fingerprint, GITHUB_KEY_SALT, 100_000, 32, "sha256");
}

function fileStore(token: string): void {
  const key = deriveKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  let ciphertext = cipher.update(token, "utf8", "hex");
  ciphertext += cipher.final("hex");
  const tag = cipher.getAuthTag();

  const envelope = { version: 1, iv: iv.toString("hex"), tag: tag.toString("hex"), ciphertext };
  const filePath = getFilePath();
  const dir = path.dirname(filePath);

  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(envelope), { mode: 0o600 });
}

function fileRetrieve(): string | null {
  const filePath = getFilePath();
  if (!fs.existsSync(filePath)) return null;

  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const envelope = JSON.parse(raw);
    if (envelope.version !== 1) return null;

    const key = deriveKey();
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "hex"));
    decipher.setAuthTag(Buffer.from(envelope.tag, "hex"));
    let plaintext = decipher.update(envelope.ciphertext, "hex", "utf8");
    plaintext += decipher.final("utf8");
    return plaintext;
  } catch {
    fileClear();
    return null;
  }
}

function fileClear(): void {
  const filePath = getFilePath();
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}

// ============================================
// GitHub User Profile
// ============================================

/**
 * Fetch the authenticated user's GitHub profile via the GitHub API.
 */
async function fetchGitHubUser(token: string): Promise<GitHubUser | null> {
  try {
    const resp = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });

    if (!resp.ok) return null;

    const data = (await resp.json()) as Record<string, unknown>;
    return {
      username: (data.login as string) || "",
      name: (data.name as string) || "",
      email: (data.email as string) || "",
      avatarUrl: (data.avatar_url as string) || "",
      profileUrl: (data.html_url as string) || "",
    };
  } catch {
    return null;
  }
}

// ============================================
// Extract GitHub username from JWT
// ============================================

/**
 * Extract GitHub username from a Clerk JWT's metadata.
 */
export function extractGitHubUsername(accessToken: string): string | null {
  const payload = decodeJwt(accessToken);
  if (!payload) return null;
  return payload.metadata?.githubUsername || null;
}

// ============================================
// gh CLI Integration
// ============================================

/**
 * Check if the `gh` CLI is installed and in PATH.
 */
async function checkGhCli(): Promise<boolean> {
  try {
    const proc = Bun.spawn(["which", "gh"], { stdout: "pipe", stderr: "pipe" });
    const exitCode = await proc.exited;
    return exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Configure gh CLI with a GitHub token.
 * Runs: echo TOKEN | gh auth login --with-token
 */
async function configureGhCliWithToken(token: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(["gh", "auth", "login", "--with-token"], {
      stdin: new Blob([token]),
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    return exitCode === 0;
  } catch {
    return false;
  }
}

// ============================================
// Public API — createGitHubAuth()
// ============================================

/**
 * Create a GitHubAuth instance.
 * Call this after Clerk login to manage the GitHub provider token.
 */
export function createGitHubAuth(): GitHubAuth {
  return {
    isAuthenticated(): boolean {
      return cachedToken !== null;
    },

    async getToken(): Promise<string | null> {
      // Check in-memory cache first
      if (cachedToken) return cachedToken;

      // Try stored token
      const stored = await retrieveToken();
      if (stored) return stored;

      return null;
    },

    async getUser(): Promise<GitHubUser | null> {
      if (cachedUser) return cachedUser;

      const token = await this.getToken();
      if (!token) return null;

      const user = await fetchGitHubUser(token);
      if (user) cachedUser = user;
      return user;
    },

    storeToken(token: string): void {
      persistToken(token).catch(() => {
        // Silent failure — token is still in memory cache
      });
    },

    clearToken(): void {
      clearStoredToken().catch(() => {});
    },

    async isGhCliAvailable(): Promise<boolean> {
      return checkGhCli();
    },

    async configureGhCli(token: string): Promise<boolean> {
      const available = await checkGhCli();
      if (!available) return false;
      return configureGhCliWithToken(token);
    },
  };
}

/** Singleton instance */
let _githubAuth: GitHubAuth | null = null;

/**
 * Get the global GitHubAuth singleton.
 */
export function getGitHubAuth(): GitHubAuth {
  if (!_githubAuth) {
    _githubAuth = createGitHubAuth();
  }
  return _githubAuth;
}
