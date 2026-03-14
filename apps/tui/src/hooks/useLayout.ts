/**
 * Layout Manager Hook
 *
 * Centralizes the TUI's panel/pane state into a single source of truth.
 * Manages which panels are visible, which has focus, and how they're arranged.
 *
 * Panels:
 *   - main: always present (chat, kanban, avenues, predict, etc.)
 *   - sidebar: optional right panel (processes, etc.)
 *   - overlay: replaces main content (process detail, expanded view, etc.)
 *
 * Focus flows: main → sidebar → overlay, with Escape going backwards.
 */

import { useState, useCallback } from "react";

// What's showing in the main content area
export type MainPane =
  | "chat"
  | "kanban"
  | "avenues"
  | "predict"
  | "model-select"
  | "provider-select"
  | "onboarding"
  | "animations"
  | "design";

// Optional right sidebar
export type SidebarPane = "processes" | null;

// Optional overlay that replaces the main content
export type OverlayPane =
  | { type: "process-detail"; taskId: string }
  | { type: "expanded-view" }
  | null;

export type FocusTarget = "main" | "sidebar" | "overlay";

export interface LayoutState {
  // Current panes
  mainPane: MainPane;
  sidebar: SidebarPane;
  overlay: OverlayPane;
  focus: FocusTarget;

  // Main pane
  setMainPane: (pane: MainPane) => void;
  cycleMainPane: () => void;

  // Sidebar
  toggleSidebar: (pane: SidebarPane) => void;
  closeSidebar: () => void;
  isSidebarOpen: boolean;

  // Overlay
  openOverlay: (overlay: NonNullable<OverlayPane>) => void;
  closeOverlay: () => void;
  hasOverlay: boolean;

  // Focus
  setFocus: (target: FocusTarget) => void;
  focusMain: () => void;

  // Convenience
  isMainFocused: boolean;
  isSidebarFocused: boolean;
  isOverlayFocused: boolean;

  // Go back (Escape behavior)
  goBack: () => void;
}

const MAIN_PANE_CYCLE: MainPane[] = ["chat", "kanban", "avenues", "predict"];

export function useLayout(initialMain: MainPane = "chat"): LayoutState {
  const [mainPane, setMainPaneState] = useState<MainPane>(initialMain);
  const [sidebar, setSidebar] = useState<SidebarPane>(null);
  const [overlay, setOverlay] = useState<OverlayPane>(null);
  const [focus, setFocus] = useState<FocusTarget>("main");

  const setMainPane = useCallback((pane: MainPane) => {
    setMainPaneState(pane);
    setOverlay(null); // Close overlay when switching main pane
    setFocus("main");
  }, []);

  const cycleMainPane = useCallback(() => {
    setMainPaneState((prev) => {
      const idx = MAIN_PANE_CYCLE.indexOf(prev);
      if (idx === -1) return "chat";
      return MAIN_PANE_CYCLE[(idx + 1) % MAIN_PANE_CYCLE.length];
    });
    setOverlay(null);
    setFocus("main");
  }, []);

  const toggleSidebar = useCallback((pane: SidebarPane) => {
    setSidebar((prev) => {
      if (prev === pane) {
        // Closing
        setFocus("main");
        return null;
      }
      // Opening
      setFocus("sidebar");
      return pane;
    });
  }, []);

  const closeSidebar = useCallback(() => {
    setSidebar(null);
    setFocus("main");
  }, []);

  const openOverlay = useCallback((o: NonNullable<OverlayPane>) => {
    setOverlay(o);
    setFocus("overlay");
  }, []);

  const closeOverlay = useCallback(() => {
    setOverlay(null);
    // Return focus to sidebar if it's open, otherwise main
    setFocus((prev) => sidebar ? "sidebar" : "main");
  }, [sidebar]);

  const focusMain = useCallback(() => setFocus("main"), []);

  const goBack = useCallback(() => {
    if (overlay) {
      setOverlay(null);
      setFocus(sidebar ? "sidebar" : "main");
    } else if (focus === "sidebar") {
      setFocus("main");
    } else if (mainPane !== "chat") {
      setMainPaneState("chat");
    }
  }, [overlay, focus, sidebar, mainPane]);

  return {
    mainPane,
    sidebar,
    overlay,
    focus,
    setMainPane,
    cycleMainPane,
    toggleSidebar,
    closeSidebar,
    isSidebarOpen: sidebar !== null,
    openOverlay,
    closeOverlay,
    hasOverlay: overlay !== null,
    setFocus,
    focusMain,
    isMainFocused: focus === "main",
    isSidebarFocused: focus === "sidebar",
    isOverlayFocused: focus === "overlay",
    goBack,
  };
}
