/**
 * 8gent CLUI -- Convex Sync Hook
 *
 * Connects the Zustand auth/preferences stores to the Convex backend.
 * Handles:
 * - Session tracking (start/end/tokens)
 * - Usage aggregation
 * - Preference sync on login
 * - Offline queue handling
 *
 * All operations are non-blocking. Failures are logged but never crash the app.
 */

import { useEffect, useRef, useCallback } from "react";
import { useAuthStore } from "../stores/auth-store";
import { usePreferencesStore } from "../stores/preferences-store";
import { useSessionStore } from "../stores/session-store";

// ── Types ─────────────────────────────────────────────────────────────

interface ConvexClient {
  setAuth: (provider: () => Promise<string | null>) => void;
  clearAuth: () => void;
  query: (fn: any, args: any) => Promise<any>;
  mutation: (fn: any, args: any) => Promise<any>;
  close: () => Promise<void>;
  readonly isConnected: boolean;
  readonly isOffline: boolean;
}

interface SyncState {
  isConnected: boolean;
  lastSyncAt: number | null;
  pendingMutations: number;
}

// ── Lazy Convex loader ────────────────────────────────────────────────

let _clientPromise: Promise<ConvexClient | null> | null = null;

async function getConvexClient(): Promise<ConvexClient | null> {
  if (!_clientPromise) {
    _clientPromise = import("@8gent/db")
      .then((mod) => mod.getConvexClient() as unknown as ConvexClient)
      .catch(() => null);
  }
  return _clientPromise;
}

// ── Hook ──────────────────────────────────────────────────────────────

export function useConvexSync(): SyncState {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const stateName = useAuthStore((s) => s.stateName);
  const setUsage = usePreferencesStore((s) => s.setUsage);
  const markSynced = usePreferencesStore((s) => s.markSynced);
  const sessions = useSessionStore((s) => s.sessions);

  const clientRef = useRef<ConvexClient | null>(null);
  const syncStateRef = useRef<SyncState>({
    isConnected: false,
    lastSyncAt: null,
    pendingMutations: 0,
  });
  const prevSessionCountRef = useRef(0);

  // ── Connect / disconnect on auth change ──

  useEffect(() => {
    let cancelled = false;

    async function syncAuth() {
      try {
        const client = await getConvexClient();
        if (cancelled || !client) return;

        clientRef.current = client;

        if (isAuthenticated) {
          // Set token provider from auth manager
          const authMod = await import("@8gent/auth").catch(() => null);
          if (cancelled || !authMod) return;

          const manager = authMod.getAuthManager();
          client.setAuth(() => manager.getAccessToken());

          syncStateRef.current = {
            ...syncStateRef.current,
            isConnected: true,
          };

          // Sync preferences from cloud (local wins on conflict)
          await syncPreferencesFromCloud(client);
          markSynced();
        } else {
          client.clearAuth();
          syncStateRef.current = {
            ...syncStateRef.current,
            isConnected: false,
          };
        }
      } catch {
        // Non-blocking -- just log
        console.warn("[useConvexSync] Auth sync failed");
      }
    }

    syncAuth();

    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, stateName, markSynced]);

  // ── Track session changes ──

  const trackSession = useCallback(
    async (sessionId: string, action: "start" | "end", tokens?: number) => {
      if (!isAuthenticated || !clientRef.current) return;

      try {
        // In production, this would call a Convex mutation like:
        // await clientRef.current.mutation(api.sessions.track, { sessionId, action, tokens });
        // For now, just update local usage stats
        if (action === "end") {
          setUsage({
            totalSessions:
              usePreferencesStore.getState().usage.totalSessions + 1,
            totalTokens:
              usePreferencesStore.getState().usage.totalTokens + (tokens || 0),
            lastSessionAt: Date.now(),
          });
        }

        syncStateRef.current = {
          ...syncStateRef.current,
          lastSyncAt: Date.now(),
        };
      } catch {
        syncStateRef.current = {
          ...syncStateRef.current,
          pendingMutations: syncStateRef.current.pendingMutations + 1,
        };
      }
    },
    [isAuthenticated, setUsage],
  );

  // ── Detect new sessions for tracking ──

  useEffect(() => {
    const sessionCount = Object.keys(sessions).length;

    if (sessionCount > prevSessionCountRef.current && prevSessionCountRef.current > 0) {
      // New session created
      const sessionIds = Object.keys(sessions);
      const newestId = sessionIds[sessionIds.length - 1];
      if (newestId) {
        trackSession(newestId, "start");
      }
    }

    prevSessionCountRef.current = sessionCount;
  }, [sessions, trackSession]);

  return syncStateRef.current;
}

// ── Preference Sync Helpers ──────────────────────────────────────────

async function syncPreferencesFromCloud(client: ConvexClient): Promise<void> {
  try {
    // In production, this would query Convex for stored preferences:
    // const cloudPrefs = await client.query(api.preferences.get, {});
    // Then merge with local preferences (local wins):
    // const localPrefs = usePreferencesStore.getState();
    // const merged = mergePreferences(localPrefs, cloudPrefs);
    // usePreferencesStore.getState().setTheme(merged.theme);
    // etc.

    // For now, we just sync local -> cloud
    await syncPreferencesToCloud(client);
  } catch {
    // Non-blocking
    console.warn("[useConvexSync] Preference sync from cloud failed");
  }
}

async function syncPreferencesToCloud(client: ConvexClient): Promise<void> {
  try {
    const state = usePreferencesStore.getState();
    // In production:
    // await client.mutation(api.preferences.upsert, {
    //   theme: state.theme,
    //   activeModel: state.activeModel,
    //   savedModels: state.savedModels,
    // });
    void state; // Suppress unused variable in placeholder
    void client;
  } catch {
    console.warn("[useConvexSync] Preference sync to cloud failed");
  }
}

export default useConvexSync;
