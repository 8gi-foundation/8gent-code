import { useState, useEffect, useCallback, useRef } from "react";
import { useSelection } from "./useSelection.js";
import type { TaskInfo, TaskOutput, TaskStatus } from "../../../../packages/tools/background.js";
import { getBackgroundTaskManager } from "../../../../packages/tools/background.js";

export type FocusZone = "input" | "sidebar" | "detail";

export interface ProcessPanelState {
  // Sidebar
  sidebarOpen: boolean;
  focusZone: FocusZone;
  toggleSidebar: () => void;

  // Task list
  tasks: TaskInfo[];
  taskCounts: Record<TaskStatus, number>;
  selectedIndex: number;
  selectTask: (index: number) => void;
  nextTask: () => void;
  prevTask: () => void;
  selectedTask: TaskInfo | undefined;

  // Detail view
  detailTaskId: string | null;
  detailOutput: TaskOutput | null;
  openDetail: (taskId: string) => void;
  closeDetail: () => void;

  // Actions
  killSelected: () => { id: string; command: string } | null;

  // Focus
  focusSidebar: () => void;
  focusInput: () => void;
}

export function useProcessPanel(): ProcessPanelState {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [focusZone, setFocusZone] = useState<FocusZone>("input");
  const [tasks, setTasks] = useState<TaskInfo[]>([]);
  const [taskCounts, setTaskCounts] = useState<Record<TaskStatus, number>>({
    running: 0, completed: 0, failed: 0, killed: 0,
  });
  const [detailTaskId, setDetailTaskId] = useState<string | null>(null);
  const [detailOutput, setDetailOutput] = useState<TaskOutput | null>(null);

  const selection = useSelection(tasks, { loop: true });
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Poll task statuses
  const poll = useCallback(() => {
    try {
      const manager = getBackgroundTaskManager();
      const taskList = manager.listTasks({ limit: 50 });
      setTasks(taskList);
      setTaskCounts(manager.getTaskCounts());

      if (detailTaskId) {
        const output = manager.getTaskOutput(detailTaskId, { tail: 200 });
        if (output) setDetailOutput(output);
      }
    } catch {
      // Manager may not exist yet
    }
  }, [detailTaskId]);

  // Start/stop polling based on visibility
  useEffect(() => {
    // Always do an initial poll
    poll();

    if (sidebarOpen || detailTaskId) {
      pollRef.current = setInterval(poll, 1000);
      return () => {
        if (pollRef.current) clearInterval(pollRef.current);
      };
    }
  }, [sidebarOpen, detailTaskId, poll]);

  const toggleSidebar = useCallback(() => {
    setSidebarOpen((prev) => {
      const next = !prev;
      if (next) {
        setFocusZone("sidebar");
      } else {
        setFocusZone("input");
        setDetailTaskId(null);
      }
      return next;
    });
  }, []);

  const openDetail = useCallback((taskId: string) => {
    setDetailTaskId(taskId);
    setFocusZone("detail");
    // Immediate fetch
    try {
      const manager = getBackgroundTaskManager();
      const output = manager.getTaskOutput(taskId, { tail: 200 });
      if (output) setDetailOutput(output);
    } catch {}
  }, []);

  const closeDetail = useCallback(() => {
    setDetailTaskId(null);
    setDetailOutput(null);
    setFocusZone("sidebar");
  }, []);

  const focusSidebar = useCallback(() => setFocusZone("sidebar"), []);
  const focusInput = useCallback(() => setFocusZone("input"), []);

  const killSelected = useCallback((): { id: string; command: string } | null => {
    const task = detailTaskId
      ? tasks.find((t) => t.id === detailTaskId)
      : selection.selectedItem;
    if (!task || task.status !== "running") return null;

    try {
      const manager = getBackgroundTaskManager();
      manager.killTask(task.id);
      return { id: task.id, command: task.command };
    } catch {
      return null;
    }
  }, [detailTaskId, tasks, selection.selectedItem]);

  return {
    sidebarOpen,
    focusZone,
    toggleSidebar,
    tasks,
    taskCounts,
    selectedIndex: selection.selectedIndex,
    selectTask: selection.select,
    nextTask: selection.next,
    prevTask: selection.prev,
    selectedTask: selection.selectedItem,
    detailTaskId,
    detailOutput,
    openDetail,
    closeDetail,
    killSelected,
    focusSidebar,
    focusInput,
  };
}
