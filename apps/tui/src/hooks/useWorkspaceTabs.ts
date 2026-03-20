/**
 * 8gent Code - Workspace Tabs Hook
 *
 * Manages tabbed workspace state: multiple chat tabs + singleton utility tabs.
 * Persists tab state to ~/.8gent/tabs/state.json.
 *
 * Features:
 * - Pinned tabs (can't be closed)
 * - Badge counts for unread/pending indicators
 * - Singleton enforcement for non-chat types
 * - Max 20 tabs
 * - Ordered: pinned first, then by lastAccessedAt
 */

import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import * as fs from "fs";
import * as path from "path";

// ============================================
// Types
// ============================================

export type TabType =
  | "chat"
  | "notes"
  | "ideas"
  | "btw"
  | "questions"
  | "kanban"
  | "music"
  | "projects";

export interface WorkspaceTab {
  id: string;
  type: TabType;
  title: string;
  active: boolean;
  createdAt: string;
  lastAccessedAt: string;
  pinned: boolean;
  badge?: number;
  data: Record<string, unknown>;
}

export interface TabIcon {
  type: TabType;
  icon: string;
  label: string;
}

export const TAB_ICONS: TabIcon[] = [
  { type: "chat", icon: ">>", label: "Chat" },
  { type: "notes", icon: "N:", label: "Notes" },
  { type: "ideas", icon: "*:", label: "Ideas" },
  { type: "btw", icon: "!:", label: "BTW" },
  { type: "questions", icon: "?:", label: "Questions" },
  { type: "kanban", icon: "#:", label: "Kanban" },
  { type: "music", icon: "~:", label: "Music" },
  { type: "projects", icon: "P:", label: "Projects" },
];

/** Singleton tab types (only one instance allowed) */
const SINGLETON_TYPES: TabType[] = [
  "notes",
  "ideas",
  "btw",
  "questions",
  "kanban",
  "music",
  "projects",
];

const MAX_TABS = 20;

const TABS_DIR = path.join(process.env.HOME || "~", ".8gent", "tabs");
const STATE_FILE = path.join(TABS_DIR, "state.json");

// ============================================
// Persistence
// ============================================

function ensureDir(): void {
  try {
    if (!fs.existsSync(TABS_DIR)) {
      fs.mkdirSync(TABS_DIR, { recursive: true });
    }
  } catch {
    // Silently fail — persistence is best-effort
  }
}

/** Migrate legacy tabs that lack new fields */
function migrateTab(raw: Record<string, unknown>): WorkspaceTab {
  const now = new Date().toISOString();
  return {
    id: (raw.id as string) || `unknown-${Date.now()}`,
    type: (raw.type as TabType) || "chat",
    title: (raw.title as string) || "Untitled",
    active: Boolean(raw.active),
    createdAt: (raw.createdAt as string) || now,
    lastAccessedAt: (raw.lastAccessedAt as string) || (raw.createdAt as string) || now,
    pinned: Boolean(raw.pinned),
    badge: typeof raw.badge === "number" ? raw.badge : undefined,
    data: (raw.data as Record<string, unknown>) || {},
  };
}

function loadState(): WorkspaceTab[] | null {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = fs.readFileSync(STATE_FILE, "utf-8");
      const data = JSON.parse(raw);
      if (Array.isArray(data) && data.length > 0) {
        return data.map((item: Record<string, unknown>) => migrateTab(item));
      }
    }
  } catch {
    // Corrupt state — will reset
  }
  return null;
}

function saveState(tabs: WorkspaceTab[]): void {
  try {
    ensureDir();
    fs.writeFileSync(STATE_FILE, JSON.stringify(tabs, null, 2), "utf-8");
  } catch {
    // Best-effort persistence
  }
}

// ============================================
// Ordering
// ============================================

/** Sort tabs: pinned first, then by lastAccessedAt descending */
function sortTabs(tabs: WorkspaceTab[]): WorkspaceTab[] {
  return [...tabs].sort((a, b) => {
    // Pinned first
    if (a.pinned && !b.pinned) return -1;
    if (!a.pinned && b.pinned) return 1;
    // Within same pin group, stable creation order
    return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
  });
}

// ============================================
// Default state
// ============================================

function makeDefaultTabs(): WorkspaceTab[] {
  const now = new Date().toISOString();
  return [
    {
      id: `chat-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      type: "chat",
      title: "Chat 1",
      active: true,
      createdAt: now,
      lastAccessedAt: now,
      pinned: true,
      data: {},
    },
    {
      id: `notes-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      type: "notes",
      title: "Notes",
      active: false,
      createdAt: now,
      lastAccessedAt: now,
      pinned: true,
      data: {},
    },
  ];
}

function generateId(type: TabType): string {
  return `${type}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

// ============================================
// Hook
// ============================================

export function useWorkspaceTabs() {
  const [tabs, setTabs] = useState<WorkspaceTab[]>(() => {
    return loadState() || makeDefaultTabs();
  });

  const saveTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounced save — persist on every mutation
  const scheduleSave = useCallback((newTabs: WorkspaceTab[]) => {
    if (saveTimeout.current) clearTimeout(saveTimeout.current);
    saveTimeout.current = setTimeout(() => saveState(newTabs), 300);
  }, []);

  // Save on every change
  useEffect(() => {
    scheduleSave(tabs);
  }, [tabs, scheduleSave]);

  // Flush pending save on unmount
  useEffect(() => {
    return () => {
      if (saveTimeout.current) {
        clearTimeout(saveTimeout.current);
        saveState(tabs);
      }
    };
  }, [tabs]);

  // Computed: sorted tabs for display
  const sortedTabs = useMemo(() => sortTabs(tabs), [tabs]);

  // Computed: current active tab
  const activeTab = useMemo(
    () => tabs.find((t) => t.active) || tabs[0],
    [tabs]
  );

  // ----------------------------------------
  // addTab
  // ----------------------------------------
  const addTab = useCallback(
    (type: TabType, title?: string): WorkspaceTab | null => {
      let newTab: WorkspaceTab | null = null;

      setTabs((prev) => {
        if (prev.length >= MAX_TABS) return prev;

        // For singleton types, switch to existing instead of creating new
        if (SINGLETON_TYPES.includes(type)) {
          const existing = prev.find((t) => t.type === type);
          if (existing) {
            const now = new Date().toISOString();
            return prev.map((t) => ({
              ...t,
              active: t.id === existing.id,
              lastAccessedAt: t.id === existing.id ? now : t.lastAccessedAt,
            }));
          }
        }

        const icon = TAB_ICONS.find((i) => i.type === type);
        const chatCount =
          type === "chat"
            ? prev.filter((t) => t.type === "chat").length + 1
            : 0;
        const defaultTitle =
          type === "chat" ? `Chat ${chatCount}` : icon?.label || type;

        const now = new Date().toISOString();
        newTab = {
          id: generateId(type),
          type,
          title: title || defaultTitle,
          active: true,
          createdAt: now,
          lastAccessedAt: now,
          pinned: false,
          data: {},
        };

        return [...prev.map((t) => ({ ...t, active: false })), newTab];
      });

      return newTab;
    },
    []
  );

  // ----------------------------------------
  // removeTab
  // ----------------------------------------
  const removeTab = useCallback((tabId: string) => {
    setTabs((prev) => {
      const target = prev.find((t) => t.id === tabId);
      if (!target) return prev;

      // Cannot close pinned tabs
      if (target.pinned) return prev;

      // Cannot close the last chat tab
      const chatTabs = prev.filter((t) => t.type === "chat");
      if (target.type === "chat" && chatTabs.length <= 1) return prev;

      // Cannot close if it's the only tab
      if (prev.length <= 1) return prev;

      const idx = prev.findIndex((t) => t.id === tabId);
      const wasActive = target.active;
      const next = prev.filter((t) => t.id !== tabId);

      // If we removed the active tab, activate the nearest one
      if (wasActive && next.length > 0) {
        const newActiveIdx = Math.min(idx, next.length - 1);
        const now = new Date().toISOString();
        next[newActiveIdx] = {
          ...next[newActiveIdx],
          active: true,
          lastAccessedAt: now,
        };
      }

      return next;
    });
  }, []);

  // ----------------------------------------
  // switchTab
  // ----------------------------------------
  const switchTab = useCallback((tabId: string) => {
    setTabs((prev) => {
      const target = prev.find((t) => t.id === tabId);
      if (!target || target.active) return prev;

      const now = new Date().toISOString();
      return prev.map((t) => ({
        ...t,
        active: t.id === tabId,
        lastAccessedAt: t.id === tabId ? now : t.lastAccessedAt,
      }));
    });
  }, []);

  // ----------------------------------------
  // switchTabByIndex (for Ctrl+1-9)
  // ----------------------------------------
  const switchToIndex = useCallback((index: number) => {
    setTabs((prev) => {
      const sorted = sortTabs(prev);
      if (index < 0 || index >= sorted.length) return prev;

      const targetId = sorted[index].id;
      const now = new Date().toISOString();
      return prev.map((t) => ({
        ...t,
        active: t.id === targetId,
        lastAccessedAt: t.id === targetId ? now : t.lastAccessedAt,
      }));
    });
  }, []);

  // ----------------------------------------
  // cycleTab (Shift+Tab)
  // ----------------------------------------
  const cycleTab = useCallback((direction: 1 | -1 = 1) => {
    setTabs((prev) => {
      const sorted = sortTabs(prev);
      const activeIdx = sorted.findIndex((t) => t.active);
      if (activeIdx === -1) return prev;

      const newIdx = (activeIdx + direction + sorted.length) % sorted.length;
      const targetId = sorted[newIdx].id;
      const now = new Date().toISOString();

      return prev.map((t) => ({
        ...t,
        active: t.id === targetId,
        lastAccessedAt: t.id === targetId ? now : t.lastAccessedAt,
      }));
    });
  }, []);

  // ----------------------------------------
  // renameTab
  // ----------------------------------------
  const renameTab = useCallback((tabId: string, title: string) => {
    setTabs((prev) =>
      prev.map((t) => (t.id === tabId ? { ...t, title } : t))
    );
  }, []);

  // ----------------------------------------
  // pinTab / unpinTab
  // ----------------------------------------
  const pinTab = useCallback((tabId: string) => {
    setTabs((prev) =>
      prev.map((t) => (t.id === tabId ? { ...t, pinned: true } : t))
    );
  }, []);

  const unpinTab = useCallback((tabId: string) => {
    setTabs((prev) =>
      prev.map((t) => (t.id === tabId ? { ...t, pinned: false } : t))
    );
  }, []);

  // ----------------------------------------
  // updateBadge
  // ----------------------------------------
  const updateBadge = useCallback((tabId: string, count: number) => {
    setTabs((prev) =>
      prev.map((t) =>
        t.id === tabId
          ? { ...t, badge: count > 0 ? count : undefined }
          : t
      )
    );
  }, []);

  // ----------------------------------------
  // getTabsByType
  // ----------------------------------------
  const getTabsByType = useCallback(
    (type: TabType): WorkspaceTab[] => {
      return tabs.filter((t) => t.type === type);
    },
    [tabs]
  );

  // ----------------------------------------
  // updateTabData (backward compat with app.tsx)
  // ----------------------------------------
  const updateTabData = useCallback(
    (tabId: string, data: Record<string, unknown>) => {
      setTabs((prev) =>
        prev.map((t) =>
          t.id === tabId ? { ...t, data: { ...t.data, ...data } } : t
        )
      );
    },
    []
  );

  return {
    tabs: sortedTabs,
    activeTab,
    addTab,
    removeTab,
    switchTab,
    switchToIndex,
    cycleTab,
    renameTab,
    pinTab,
    unpinTab,
    updateBadge,
    getTabsByType,
    updateTabData,
  };
}
