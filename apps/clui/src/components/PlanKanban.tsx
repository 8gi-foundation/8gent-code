/**
 * 8gent CLUI -- Plan Kanban Board Component
 *
 * Adapted from apps/tui/src/components/plan-kanban.tsx for React DOM.
 * Three-column kanban board showing agent plan execution progress.
 *
 * Features:
 * - Columns: Planned -> In Progress -> Done
 * - Cards with category icons, priority badges, confidence
 * - Auto-advancement animation when status changes
 * - Compact mode toggle
 * - Footer with aggregate counts
 * - Framer Motion layout animations
 *
 * Color rules: uses only CSS custom properties from tokens.css
 */

import React from "react";
import { motion, AnimatePresence, LayoutGroup } from "framer-motion";

// ── Types ─────────────────────────────────────────────────────────────

export type StepCategory =
  | "exploration"
  | "modification"
  | "search"
  | "git"
  | "test"
  | "debug"
  | "refactor"
  | "documentation";

export interface PlanStep {
  id: string;
  description: string;
  tool: string;
  category: StepCategory;
  priority: number;
  confidence: number;
  status: "planned" | "in_progress" | "done";
}

export interface PlanKanbanProps {
  steps: PlanStep[];
  visible: boolean;
  onClose: () => void;
  compact?: boolean;
  maxItemsPerColumn?: number;
}

// ── Category Config ───────────────────────────────────────────────────

const CATEGORY_ICONS: Record<StepCategory, string> = {
  exploration: "\uD83D\uDD0D",
  modification: "\u270F",
  search: "\uD83D\uDD0E",
  git: "\u2387",
  test: "\u2713",
  debug: "\uD83D\uDC1B",
  refactor: "\u21BB",
  documentation: "\uD83D\uDCDD",
};

const CATEGORY_COLORS: Record<StepCategory, string> = {
  exploration: "text-accent",
  modification: "text-warning",
  search: "text-info",
  git: "text-brand",
  test: "text-success",
  debug: "text-danger",
  refactor: "text-text-secondary",
  documentation: "text-muted",
};

const PRIORITY_COLORS: Record<number, string> = {
  10: "text-danger border-danger/40",
  9: "text-danger border-danger/40",
  8: "text-warning border-8-yellow/40",
  7: "text-warning border-8-yellow/40",
  6: "text-accent border-accent/40",
  5: "text-accent border-accent/40",
  4: "text-info border-info/40",
  3: "text-info border-info/40",
  2: "text-muted border-subtle",
  1: "text-muted border-subtle",
};

// ── Column Config ─────────────────────────────────────────────────────

interface ColumnConfig {
  key: "planned" | "in_progress" | "done";
  title: string;
  colorClass: string;
  borderClass: string;
}

const COLUMNS: ColumnConfig[] = [
  { key: "planned", title: "Planned", colorClass: "text-info", borderClass: "border-info/40" },
  { key: "in_progress", title: "In Progress", colorClass: "text-accent", borderClass: "border-accent/40" },
  { key: "done", title: "Done", colorClass: "text-success", borderClass: "border-success/40" },
];

// ── Main Component ────────────────────────────────────────────────────

export function PlanKanban({
  steps,
  visible,
  onClose,
  compact = false,
  maxItemsPerColumn = 6,
}: PlanKanbanProps) {
  // Group steps by status
  const columns: Record<string, PlanStep[]> = {
    planned: steps.filter((s) => s.status === "planned"),
    in_progress: steps.filter((s) => s.status === "in_progress"),
    done: steps.filter((s) => s.status === "done"),
  };

  const totalSteps = steps.length;
  const doneCount = columns.done.length;
  const activeCount = columns.in_progress.length;

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 16 }}
          transition={{ duration: 0.2 }}
          className="
            border border-accent/30 rounded-lg
            bg-surface-secondary
            overflow-hidden
          "
        >
          {/* Header */}
          <div className="flex items-center justify-between px-3 py-2 border-b border-subtle">
            <div className="flex items-center gap-2">
              <span className="text-accent text-xs">{"\u2592"}</span>
              <span className="text-text-primary text-xs font-bold">
                Plan Kanban
              </span>
              <span className="text-muted text-xs">
                {doneCount}/{totalSteps} done
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-muted text-[10px]">
                Cmd+K to toggle
              </span>
              <button
                onClick={onClose}
                className="text-muted hover:text-accent text-xs transition-colors duration-150"
                aria-label="Close kanban"
              >
                &times;
              </button>
            </div>
          </div>

          {/* Columns */}
          <LayoutGroup>
            <div className="flex divide-x divide-subtle">
              {COLUMNS.map((col) => (
                <KanbanColumn
                  key={col.key}
                  config={col}
                  items={columns[col.key]}
                  maxItems={maxItemsPerColumn}
                  compact={compact}
                />
              ))}
            </div>
          </LayoutGroup>

          {/* Footer */}
          <div className="flex items-center justify-between px-3 py-1.5 border-t border-subtle text-xs">
            <span className="text-muted">
              Total: {totalSteps} steps
            </span>
            <div className="flex items-center gap-3">
              <span className="text-info">
                Planned: {columns.planned.length}
              </span>
              <span className="text-accent">
                Active: {activeCount}
              </span>
              <span className="text-success">
                Done: {doneCount}
              </span>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// ── Column ────────────────────────────────────────────────────────────

interface KanbanColumnProps {
  config: ColumnConfig;
  items: PlanStep[];
  maxItems: number;
  compact: boolean;
}

function KanbanColumn({ config, items, maxItems, compact }: KanbanColumnProps) {
  const displayItems = items.slice(0, maxItems);
  const hiddenCount = items.length - displayItems.length;

  return (
    <div className="flex-1 min-w-0 flex flex-col">
      {/* Column header */}
      <div className={`flex items-center justify-between px-2 py-1.5 border-b ${config.borderClass}`}>
        <span className={`text-xs font-bold ${config.colorClass}`}>
          {config.title}
        </span>
        <span
          className={`
            text-[10px] px-1 py-0 rounded border
            ${config.colorClass} ${config.borderClass}
          `}
        >
          {items.length}
        </span>
      </div>

      {/* Cards */}
      <div className="flex flex-col gap-0.5 p-1 min-h-[60px]">
        <AnimatePresence mode="popLayout">
          {displayItems.map((step) => (
            <KanbanCard key={step.id} step={step} compact={compact} />
          ))}
        </AnimatePresence>

        {items.length === 0 && (
          <div className="text-muted text-[10px] text-center py-3 italic">
            (empty)
          </div>
        )}

        {hiddenCount > 0 && (
          <div className="text-muted text-[10px] text-center py-1">
            +{hiddenCount} more...
          </div>
        )}
      </div>
    </div>
  );
}

// ── Card ──────────────────────────────────────────────────────────────

interface KanbanCardProps {
  step: PlanStep;
  compact: boolean;
}

function KanbanCard({ step, compact }: KanbanCardProps) {
  const categoryColor = CATEGORY_COLORS[step.category] || "text-muted";
  const categoryIcon = CATEGORY_ICONS[step.category] || "\u25CF";
  const priorityColor = PRIORITY_COLORS[step.priority] || "text-muted border-subtle";

  const truncatedDesc =
    step.description.length > 40
      ? step.description.slice(0, 37) + "..."
      : step.description;

  if (compact) {
    return (
      <motion.div
        layout
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        transition={{ duration: 0.15 }}
        className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-surface-elevated/50"
      >
        <span className={`${categoryColor} text-[10px]`}>{categoryIcon}</span>
        <span className="text-text-primary text-[10px] truncate flex-1">
          {truncatedDesc}
        </span>
      </motion.div>
    );
  }

  return (
    <motion.div
      layout
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.95 }}
      transition={{ duration: 0.15 }}
      className="
        px-2 py-1.5 rounded
        bg-surface-elevated/50
        border border-subtle/50
        hover:border-accent/30
        transition-colors duration-100
      "
    >
      {/* Category + Priority */}
      <div className="flex items-center justify-between mb-0.5">
        <span className={`${categoryColor} text-[10px]`}>
          {categoryIcon} {step.category}
        </span>
        <span className={`text-[9px] px-1 rounded border ${priorityColor}`}>
          P{step.priority}
        </span>
      </div>

      {/* Description */}
      <div className="text-text-primary text-xs leading-tight">
        {truncatedDesc}
      </div>

      {/* Confidence */}
      <div className="text-muted text-[10px] mt-0.5">
        {Math.round(step.confidence * 100)}% conf
      </div>
    </motion.div>
  );
}

export default PlanKanban;
