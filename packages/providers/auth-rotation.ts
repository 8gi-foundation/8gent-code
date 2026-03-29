/**
 * 8gent Code - Auth Profile Rotation
 *
 * Round-robin API key rotation with rate-limit cooldown.
 * Profiles stored in ~/.8gent/auth-profiles.json.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export interface AuthProfile {
  id: string;
  provider: string;
  apiKey: string;
  priority: number;
  cooldownUntil?: number;
  failCount: number;
  lastUsed?: number;
}

const DEFAULT_COOLDOWN_MS = 60_000;
const MAX_FAIL_COUNT = 5;

export class AuthRotator {
  private profiles: AuthProfile[] = [];
  private configPath: string;

  constructor(configPath?: string) {
    this.configPath = configPath || join(homedir(), ".8gent", "auth-profiles.json");
    this.load();
  }

  private load(): void {
    try {
      if (existsSync(this.configPath)) {
        this.profiles = JSON.parse(readFileSync(this.configPath, "utf-8"));
      }
    } catch {
      this.profiles = [];
    }
  }

  private save(): void {
    const dir = join(this.configPath, "..");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(this.configPath, JSON.stringify(this.profiles, null, 2));
  }

  /** Return the best available key for a provider via round-robin, skipping cooled-down/failing profiles. */
  getKey(provider: string): string | null {
    const now = Date.now();
    const candidates = this.profiles
      .filter(
        (p) =>
          p.provider === provider &&
          p.failCount < MAX_FAIL_COUNT &&
          (!p.cooldownUntil || p.cooldownUntil <= now)
      )
      .sort((a, b) => {
        // Priority first (lower = better), then least-recently-used
        if (a.priority !== b.priority) return a.priority - b.priority;
        return (a.lastUsed ?? 0) - (b.lastUsed ?? 0);
      });

    if (candidates.length === 0) return null;

    const pick = candidates[0];
    pick.lastUsed = now;
    this.save();
    return pick.apiKey;
  }

  markRateLimited(profileId: string, cooldownMs = DEFAULT_COOLDOWN_MS): void {
    const p = this.profiles.find((x) => x.id === profileId);
    if (!p) return;
    p.cooldownUntil = Date.now() + cooldownMs;
    this.save();
  }

  markFailed(profileId: string): void {
    const p = this.profiles.find((x) => x.id === profileId);
    if (!p) return;
    p.failCount++;
    this.save();
  }

  markSuccess(profileId: string): void {
    const p = this.profiles.find((x) => x.id === profileId);
    if (!p) return;
    p.failCount = 0;
    p.cooldownUntil = undefined;
    this.save();
  }

  addProfile(profile: AuthProfile): void {
    const idx = this.profiles.findIndex((x) => x.id === profile.id);
    if (idx >= 0) {
      this.profiles[idx] = profile;
    } else {
      this.profiles.push(profile);
    }
    this.save();
  }

  getHealth(): Array<{ id: string; status: "healthy" | "rate-limited" | "failing" }> {
    const now = Date.now();
    return this.profiles.map((p) => {
      const status = p.failCount >= MAX_FAIL_COUNT ? "failing"
        : (p.cooldownUntil && p.cooldownUntil > now) ? "rate-limited" : "healthy";
      return { id: p.id, status };
    });
  }
}
