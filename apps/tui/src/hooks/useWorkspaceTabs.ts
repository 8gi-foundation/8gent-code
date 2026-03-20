/**
 * 8gent Code - Workspace Tabs Hook
 *
 * Manages tabbed workspace state: multiple chat tabs + singleton utility tabs.
 * Persists tab state to ~/.8gent/tabs/state.json.
 */

import { useState, useCallback, useEffect, useRef } from "react";
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

function ensureDir() {
  try {
    if (!fs.existsSync(TABS_DIR)) {
      fs.mkdirSync(TABS_DIR, { recursive: true });
    }
  } catch {
    // Silently fail — persistence is best-effort
  }
}

function loadState(): WorkspaceTab[] | null {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = fs.readFileSync(STATE_FILE, "utf-8");
      const data = JSON.parse(raw);
      if (Array.isArray(data) && data.length > 0) {
        return data as WorkspaceTab[];
      }
    }
  } catch {
    // Corrupt state — will reset
  }
  return null;
}

function saveState(tabs: WorkspaceTab[]) {
  try {
    ensureDir();
    fs.writeFileSync(STATE_FILE, JSON.stringify(tabs, null, 2), "utf-8");
  } catch {
    // Best-effort persistence
  }
}

// ============================================
// Default state
// ============================================

function makeDefaultTabs(): WorkspaceTab[] {
  return [
    {
      id: `chat-${Date.now()}`,
      type: "chat",
      title: "Chat",
      active: true,
      createdAt: new Date().toISOString(),
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

  // Debounced save
  const scheduleSave = useCallback((newTabs: WorkspaceTab[]) => {
    if (saveTimeout.current) clearTimeout(saveTimeout.current);
    saveTimeout.current = setTimeout(() => saveState(newTabs), 500);
  }, []);

  // Save on every change
  useEffect(() => {
    scheduleSave(tabs);
  }, [tabs, scheduleSave]);

  const activeTab = tabs.find((t) => t.active) || tabs[0];

  const addTab = useCallback(
    (type: TabType, title?: string): WorkspaceTab | null => {
      let newTab: WorkspaceTab | null = null;

      setTabs((prev) => {
        if (prev.length >= MAX_TABS) return prev;

        // For singleton types, switch to existing instead of creating new
        if (SINGLETON_TYPES.includes(type)) {
          const existing = prev.find((t) => t.type === type);
          if (existing) {
            return prev.map((t) => ({ ...t, active: t.id === existing.id }));
          }
        }

        const icon = TAB_ICONS.find((i) => i.type === type);
        const chatCount = type === "chat" ? prev.filter((t) => t.type === "chat").length + 1 : 0;
        const defaultTitle = type === "chat" ? `Chat ${chatCount}` : icon?.label || type;

        newTab = {
          id: generateId(type),
          type,
          title: title || defaultTitle,
          active: true,
          createdAt: new Date().toISOString(),
          data: {},
        };

        return [...prev.map((t) => ({ ...t, active: false })), newTab];
      });

      return newTab;
    },
    []
  );

  const removeTab = useCallback(
    (tabId: string) => {
      setTabs((prev) => {
        // Cannot close last tab
        if (prev.length <= 1) return prev;

        const idx = prev.findIndex((t) => t.id === tabId);
        if (idx === -1) return prev;

        const wasActive = prev[idx].active;
        const next = prev.filter((t) => t.id !== tabId);

        // If we removed the active tab, activate the nearest one
        if (wasActive && next.length > 0) {
          const newActiveIdx = Math.min(idx, next.length - 1);
          next[newActiveIdx] = { ...next[newActiveIdx], active: true };
        }

        return next;
      });
    },
    []
  );

  const switchTab = useCallback(
    (tabId: string) => {
      setTabs((prev) =>
        prev.map((t) => ({ ...t, active: t.id === tabId }))
      );
    },
    []
  );

  const switchToIndex = useCallback(
    (index: number) => {
      setTabs((prev) => {
        if (index < 0 || index >= prev.length) return prev;
        return prev.map((t, i) => ({ ...t, active: i === index }));
      });
    },
    []
  );

  const cycleTab = useCallback(
    (direction: 1 | -1 = 1) => {
      setTabs((prev) => {
        const activeIdx = prev.findIndex((t) => t.active);
        if (activeIdx === -1) return prev;
        const newIdx = (activeIdx + direction + prev.length) % prev.length;
        return prev.map((t, i) => ({ ...t, active: i === newIdx }));
      });
    },
    []
  );

  const renameTab = useCallback(
    (tabId: string, title: string) => {
      setTabs((prev) =>
        prev.map((t) => (t.id === tabId ? { ...t, title } : t))
      );
    },
    []
  );

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
    tabs,
    activeTab,
    addTab,
    removeTab,
    switchTab,
    switchToIndex,
    cycleTab,
    renameTab,
    updateTabData,
  };
}
