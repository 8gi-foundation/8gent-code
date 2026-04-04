import { useState, useEffect, useCallback, useRef } from "react";
import { useSelection } from "./useSelection.js";
import type { TaskInfo, TaskOutput, TaskStatus } from "../../../../packages/tools/background.js";
import { getBackgroundTaskManager } from "../../../../packages/tools/background.js";
import {
  getActivityLogAsTaskInfos,
  getAgentTaskOutput,
  isAgentProcessTaskId,
} from "../components/ActivityMonitor.js";

function mergeTasksByRecency(shell: TaskInfo[], agent: TaskInfo[]): TaskInfo[] {
  const all = [...shell, ...agent];
  all.sort(
    (a, b) =>
      new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
  );
  return all;
}

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

  // Poll shell jobs + agent tool trace (activity log) so Ctrl+B reflects real work
  const poll = useCallback(() => {
    try {
      const manager = getBackgroundTaskManager();
      const shellTasks = manager.listTasks({ limit: 40 });
      const agentTasks = getActivityLogAsTaskInfos();
      const merged = mergeTasksByRecency(shellTasks, agentTasks).slice(0, 60);
      setTasks(merged);

      const base = manager.getTaskCounts();
      const agentRunning = agentTasks.filter((t) => t.status === "running").length;
      setTaskCounts({
        ...base,
        running: base.running + agentRunning,
      });

      if (detailTaskId) {
        if (isAgentProcessTaskId(detailTaskId)) {
          const out = getAgentTaskOutput(detailTaskId);
          if (out) setDetailOutput(out);
        } else {
          const output = manager.getTaskOutput(detailTaskId, { tail: 200 });
          if (output) setDetailOutput(output);
        }
      }
    } catch {
      // Manager may not exist yet
    }
  }, [detailTaskId]);

  // Keep process list fresh (badge + instant sidebar) without heavy CPU
  useEffect(() => {
    poll();
    pollRef.current = setInterval(poll, 1500);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [poll]);

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
    try {
      if (isAgentProcessTaskId(taskId)) {
        const out = getAgentTaskOutput(taskId);
        if (out) setDetailOutput(out);
        return;
      }
      const manager = getBackgroundTaskManager();
      const output = manager.getTaskOutput(taskId, { tail: 200 });
      if (output) setDetailOutput(output);
    } catch {
      /* ignore */
    }
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
    if (isAgentProcessTaskId(task.id)) return null;

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
