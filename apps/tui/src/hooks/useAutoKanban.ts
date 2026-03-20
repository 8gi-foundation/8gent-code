/**
 * 8gent Code - Auto-Populating Kanban Hook
 *
 * Creates kanban cards automatically from agent tool events
 * and assigns them to workspace chat tabs.
 *
 * Cards flow: ready → in-progress → done/failed
 * based on real tool start/end events, not predictions.
 */

import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import * as fs from "fs";
import * as path from "path";

// ============================================
// Types
// ============================================

export interface KanbanCard {
  id: string;
  title: string;
  description: string;
  status: "backlog" | "ready" | "in-progress" | "done" | "failed";
  assignedTo: string; // chat tab ID
  assignedTabName: string; // chat tab display name
  toolName?: string;
  toolCallId?: string;
  parentId?: string; // links sub-task to parent user message card
  startedAt?: number;
  completedAt?: number;
  durationMs?: number;
  icon: string;
}

export interface AutoKanbanColumns {
  backlog: KanbanCard[];
  ready: KanbanCard[];
  inProgress: KanbanCard[];
  done: KanbanCard[];
}

export interface AutoKanbanStats {
  total: number;
  active: number;
  done: number;
  failed: number;
}

export interface UseAutoKanbanReturn {
  cards: KanbanCard[];
  onTaskStart: (tabId: string, tabName: string, toolName: string, toolCallId: string, args: Record<string, unknown>) => void;
  onTaskComplete: (toolCallId: string, success: boolean, durationMs: number) => void;
  onUserMessage: (tabId: string, tabName: string, message: string) => void;
  clearDone: () => void;
  clearAll: () => void;
  columns: AutoKanbanColumns;
  stats: AutoKanbanStats;
}

// ============================================
// Constants
// ============================================

const MAX_CARDS = 100;
const KANBAN_DIR = path.join(process.env.HOME || "~", ".8gent", "tabs");
const KANBAN_FILE = path.join(KANBAN_DIR, "kanban.json");

// ============================================
// Tool → Title mapping
// ============================================

function toolToTitle(toolName: string, args: Record<string, unknown>): string {
  switch (toolName) {
    case "web_search":
      return `Search: ${truncStr(String(args.query || ""), 30)}`;
    case "web_fetch": {
      const url = String(args.url || "");
      try {
        return `Fetch: ${new URL(url).hostname}`;
      } catch {
        return `Fetch: ${truncStr(url, 30)}`;
      }
    }
    case "read_file": {
      const filename = String(args.path || "").split("/").pop() || "file";
      return `Read: ${filename}`;
    }
    case "write_file": {
      const filename = String(args.path || "").split("/").pop() || "file";
      return `Write: ${filename}`;
    }
    case "edit_file": {
      const filename = String(args.path || "").split("/").pop() || "file";
      return `Edit: ${filename}`;
    }
    case "list_files":
      return "List files";
    case "search_symbols":
    case "search_text":
      return `Search: ${truncStr(String(args.query || ""), 30)}`;
    case "run_command": {
      const cmd = String(args.command || "").slice(0, 35);
      return `Run: ${cmd}`;
    }
    default:
      return `Tool: ${toolName}`;
  }
}

function toolToIcon(toolName: string): string {
  switch (toolName) {
    case "web_search": return "\u{1F50D}"; // magnifying glass
    case "web_fetch": return "\u{1F310}"; // globe
    case "read_file": return "\u{1F4C4}"; // page
    case "write_file": return "\u270F";    // pencil
    case "edit_file": return "\u270F";     // pencil
    case "list_files": return "\u{1F4C2}"; // folder
    case "search_symbols":
    case "search_text": return "\u{1F50E}"; // search right
    case "run_command": return "\u25B6";    // play
    default: return "\u2022";               // bullet
  }
}

function truncStr(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "\u2026";
}

// ============================================
// Persistence
// ============================================

function loadKanban(): KanbanCard[] {
  try {
    if (fs.existsSync(KANBAN_FILE)) {
      const raw = fs.readFileSync(KANBAN_FILE, "utf-8");
      const data = JSON.parse(raw);
      if (Array.isArray(data)) return data;
    }
  } catch {
    // Corrupt — start fresh
  }
  return [];
}

function saveKanban(cards: KanbanCard[]): void {
  try {
    if (!fs.existsSync(KANBAN_DIR)) {
      fs.mkdirSync(KANBAN_DIR, { recursive: true });
    }
    fs.writeFileSync(KANBAN_FILE, JSON.stringify(cards, null, 2), "utf-8");
  } catch {
    // Best-effort
  }
}

// ============================================
// Hook
// ============================================

export function useAutoKanban(): UseAutoKanbanReturn {
  const [cards, setCards] = useState<KanbanCard[]>(() => loadKanban());
  const saveTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Track which user-message card is the "active parent" per tab
  const activeParentRef = useRef<Map<string, string>>(new Map());

  // Debounced save
  const scheduleSave = useCallback((newCards: KanbanCard[]) => {
    if (saveTimeout.current) clearTimeout(saveTimeout.current);
    saveTimeout.current = setTimeout(() => saveKanban(newCards), 500);
  }, []);

  useEffect(() => {
    scheduleSave(cards);
  }, [cards, scheduleSave]);

  // Flush on unmount
  useEffect(() => {
    return () => {
      if (saveTimeout.current) {
        clearTimeout(saveTimeout.current);
        saveKanban(cards);
      }
    };
  }, [cards]);

  // Prune oldest done cards when over limit
  const pruneCards = useCallback((allCards: KanbanCard[]): KanbanCard[] => {
    if (allCards.length <= MAX_CARDS) return allCards;
    // Sort done cards by completedAt ascending, remove oldest
    const doneCards = allCards
      .filter((c) => c.status === "done" || c.status === "failed")
      .sort((a, b) => (a.completedAt || 0) - (b.completedAt || 0));
    const toRemove = allCards.length - MAX_CARDS;
    const removeIds = new Set(doneCards.slice(0, toRemove).map((c) => c.id));
    return allCards.filter((c) => !removeIds.has(c.id));
  }, []);

  // ----------------------------------------
  // onUserMessage
  // ----------------------------------------
  const onUserMessage = useCallback(
    (tabId: string, tabName: string, message: string) => {
      const cardId = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const card: KanbanCard = {
        id: cardId,
        title: truncStr(message, 40),
        description: message,
        status: "ready",
        assignedTo: tabId,
        assignedTabName: tabName,
        icon: "\u{1F4AC}", // speech bubble
        startedAt: Date.now(),
      };
      activeParentRef.current.set(tabId, cardId);
      setCards((prev) => pruneCards([...prev, card]));
    },
    [pruneCards]
  );

  // ----------------------------------------
  // onTaskStart
  // ----------------------------------------
  const onTaskStart = useCallback(
    (tabId: string, tabName: string, toolName: string, toolCallId: string, args: Record<string, unknown>) => {
      const parentId = activeParentRef.current.get(tabId);

      setCards((prev) => {
        let updated = [...prev];

        // Move parent card to in-progress if it's still in ready
        if (parentId) {
          updated = updated.map((c) =>
            c.id === parentId && c.status === "ready"
              ? { ...c, status: "in-progress" as const }
              : c
          );
        }

        // Create a sub-task card for this tool call
        const card: KanbanCard = {
          id: `tool-${toolCallId}`,
          title: toolToTitle(toolName, args),
          description: toolToTitle(toolName, args),
          status: "in-progress",
          assignedTo: tabId,
          assignedTabName: tabName,
          toolName,
          toolCallId,
          parentId,
          icon: toolToIcon(toolName),
          startedAt: Date.now(),
        };

        return pruneCards([...updated, card]);
      });
    },
    [pruneCards]
  );

  // ----------------------------------------
  // onTaskComplete
  // ----------------------------------------
  const onTaskComplete = useCallback(
    (toolCallId: string, success: boolean, durationMs: number) => {
      setCards((prev) => {
        return prev.map((c) => {
          if (c.id === `tool-${toolCallId}`) {
            return {
              ...c,
              status: success ? ("done" as const) : ("failed" as const),
              completedAt: Date.now(),
              durationMs,
            };
          }
          return c;
        });
      });
    },
    []
  );

  // ----------------------------------------
  // When all sub-tasks for a parent are done, mark parent done
  // ----------------------------------------
  useEffect(() => {
    setCards((prev) => {
      let changed = false;
      const updated = prev.map((card) => {
        if (card.status !== "in-progress" || card.parentId) return card;
        // This is a parent card — check if all its children are done
        const children = prev.filter((c) => c.parentId === card.id);
        if (children.length === 0) return card;
        const allDone = children.every((c) => c.status === "done" || c.status === "failed");
        if (allDone) {
          const anyFailed = children.some((c) => c.status === "failed");
          const totalDuration = children.reduce((sum, c) => sum + (c.durationMs || 0), 0);
          changed = true;
          return {
            ...card,
            status: anyFailed ? ("failed" as const) : ("done" as const),
            completedAt: Date.now(),
            durationMs: totalDuration,
          };
        }
        return card;
      });
      return changed ? updated : prev;
    });
  }, [cards.filter((c) => c.status === "done" || c.status === "failed").length]);

  // ----------------------------------------
  // clearDone / clearAll
  // ----------------------------------------
  const clearDone = useCallback(() => {
    setCards((prev) => prev.filter((c) => c.status !== "done" && c.status !== "failed"));
  }, []);

  const clearAll = useCallback(() => {
    activeParentRef.current.clear();
    setCards([]);
  }, []);

  // ----------------------------------------
  // Computed columns
  // ----------------------------------------
  const columns = useMemo<AutoKanbanColumns>(() => {
    return {
      backlog: cards.filter((c) => c.status === "backlog"),
      ready: cards.filter((c) => c.status === "ready"),
      inProgress: cards.filter((c) => c.status === "in-progress"),
      done: cards.filter((c) => c.status === "done" || c.status === "failed"),
    };
  }, [cards]);

  // ----------------------------------------
  // Stats
  // ----------------------------------------
  const stats = useMemo<AutoKanbanStats>(() => {
    const total = cards.length;
    const active = cards.filter((c) => c.status === "in-progress").length;
    const done = cards.filter((c) => c.status === "done").length;
    const failed = cards.filter((c) => c.status === "failed").length;
    return { total, active, done, failed };
  }, [cards]);

  return {
    cards,
    onTaskStart,
    onTaskComplete,
    onUserMessage,
    clearDone,
    clearAll,
    columns,
    stats,
  };
}
