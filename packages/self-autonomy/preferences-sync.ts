/**
 * PreferencesSyncManager — Cloud sync for user preferences.
 *
 * Pulls preferences from Convex on login, merges with local .8gent/user.json.
 * Pushes local changes back to Convex after /preferences updates.
 *
 * Merge strategy: updatedAt wins. Local-only fields stay local.
 */

import * as fs from "fs";
import * as path from "path";
import type { UserConfig } from "./onboarding";

/** Fields synced to/from Convex */
interface SyncablePreferences {
  defaultModel: string;
  defaultProvider: string;
  theme: string;
  communicationStyle: string | null;
  language: string;
  gitBranchPrefix: string;
  autonomyThreshold: string;
  updatedAt: number;
}

export class PreferencesSyncManager {
  private workingDirectory: string;
  private userConfigPath: string;

  // Lazily resolved Convex client
  private _client: any = null;
  private _api: any = null;
  private _resolved = false;

  constructor(workingDirectory: string = process.cwd()) {
    this.workingDirectory = workingDirectory;
    this.userConfigPath = path.join(workingDirectory, ".8gent", "user.json");
  }

  private async resolveConvex(): Promise<boolean> {
    if (this._resolved) return this._client !== null;

    try {
      const { getConvexClient } = await import("../db/client.js");
      const { api } = await import("../db/convex/_generated/api.js");
      this._client = getConvexClient();
      this._api = api;
      this._resolved = true;
      return true;
    } catch {
      this._resolved = true;
      return false;
    }
  }

  /**
   * Pull preferences from Convex and merge with local config.
   * Called after successful authentication.
   *
   * Merge strategy: updatedAt wins. Local-only fields stay local.
   */
  async syncOnLogin(clerkId: string): Promise<void> {
    try {
      const available = await this.resolveConvex();
      if (!available) return;

      const cloudPrefs = await this._client.query(
        this._api.preferences.getByClerkId,
        { clerkId }
      );

      if (!cloudPrefs) return; // No cloud prefs yet

      const localConfig = this.loadLocalConfig();
      if (!localConfig) return;

      const localUpdatedAt = localConfig.understanding?.lastUpdated
        ? new Date(localConfig.understanding.lastUpdated).getTime()
        : 0;
      const cloudUpdatedAt = cloudPrefs.updatedAt || 0;

      if (cloudUpdatedAt > localUpdatedAt) {
        // Cloud is newer — merge cloud into local
        if (cloudPrefs.defaultModel) {
          localConfig.preferences.model.default = cloudPrefs.defaultModel;
        }
        if (cloudPrefs.defaultProvider) {
          localConfig.preferences.model.provider = cloudPrefs.defaultProvider as any;
        }
        if (cloudPrefs.communicationStyle) {
          localConfig.identity.communicationStyle = cloudPrefs.communicationStyle as any;
        }
        if (cloudPrefs.language) {
          localConfig.identity.language = cloudPrefs.language;
        }
        if (cloudPrefs.gitBranchPrefix) {
          localConfig.preferences.git.branchPrefix = cloudPrefs.gitBranchPrefix;
        }
        if (cloudPrefs.autonomyThreshold) {
          localConfig.preferences.autonomy.askThreshold = cloudPrefs.autonomyThreshold as any;
        }

        localConfig.understanding.lastUpdated = new Date(cloudUpdatedAt).toISOString();
        this.saveLocalConfig(localConfig);
      }
    } catch {
      // Sync is best-effort
    }
  }

  /**
   * Push local preferences to Convex.
   * Called after /preferences changes.
   */
  async pushToCloud(userId: string): Promise<void> {
    try {
      const available = await this.resolveConvex();
      if (!available) return;

      const localConfig = this.loadLocalConfig();
      if (!localConfig) return;

      await this._client.mutation(this._api.preferences.merge, {
        userId,
        defaultModel: localConfig.preferences.model.default || "",
        defaultProvider: localConfig.preferences.model.provider || "ollama",
        communicationStyle: localConfig.identity.communicationStyle || undefined,
        language: localConfig.identity.language || undefined,
        gitBranchPrefix: localConfig.preferences.git.branchPrefix || undefined,
        autonomyThreshold: localConfig.preferences.autonomy.askThreshold || undefined,
      });
    } catch {
      // Push is best-effort
    }
  }

  private loadLocalConfig(): UserConfig | null {
    try {
      if (fs.existsSync(this.userConfigPath)) {
        return JSON.parse(fs.readFileSync(this.userConfigPath, "utf-8"));
      }
    } catch {}
    return null;
  }

  private saveLocalConfig(config: UserConfig): void {
    const dir = path.dirname(this.userConfigPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(this.userConfigPath, JSON.stringify(config, null, 2));
  }
}
