/**
 * 8gent Code - Plan Kanban Board Component
 *
 * Mini Kanban board rendered in terminal with:
 * - 4 columns: Backlog | Ready | In Progress | Done
 * - Box-drawing characters for borders
 * - Color coded by priority/type
 * - Toggle with /kanban command
 */

import React, { useState, useEffect } from "react";
import { Box, Text, useInput } from "ink";

// Inline types to avoid import issues
export type StepCategory =
  | "exploration"
  | "modification"
  | "search"
  | "git"
  | "test"
  | "debug"
  | "refactor"
  | "documentation";

export interface ProactiveStep {
  id: string;
  description: string;
  tool: string;
  input: Record<string, unknown>;
  priority: number;
  confidence: number;
  category: StepCategory;
  predictedAt: Date;
  basedOn: string[];
}

export interface KanbanBoard {
  backlog: ProactiveStep[];
  ready: ProactiveStep[];
  inProgress: ProactiveStep[];
  done: ProactiveStep[];
}

export interface PreGeneratedStep {
  id: string;
  description: string;
  tool: string;
  input: Record<string, unknown>;
  dependencies: string[];
  optional: boolean;
}

export interface Avenue {
  id: string;
  name: string;
  description: string;
  probability: number;
  category: string;
  plan: {
    goal: string;
    steps: PreGeneratedStep[];
    estimatedTokens: number;
    estimatedTime: number;
  };
  triggers: string[];
  createdAt: Date;
  lastUpdated: Date;
  depth: number;
}

// ============================================
// Types
// ============================================

export interface PlanKanbanProps {
  board: KanbanBoard;
  visible?: boolean;
  onClose?: () => void;
  onStepSelect?: (stepId: string) => void;
  selectedStepId?: string | null;
  compact?: boolean;
  maxItemsPerColumn?: number;
}

export interface AvenueDisplayProps {
  avenues: Avenue[];
  activeAvenueId?: string | null;
  onAvenueSelect?: (avenueId: string) => void;
  visible?: boolean;
}

export interface PredictedStepsProps {
  steps: ProactiveStep[];
  visible?: boolean;
  onStepAccept?: (stepId: string) => void;
  maxItems?: number;
}

// ============================================
// Color Schemes
// ============================================

const categoryColors: Record<StepCategory, string> = {
  exploration: "cyan",
  modification: "yellow",
  search: "blue",
  git: "magenta",
  test: "green",
  debug: "red",
  refactor: "white",
  documentation: "gray",
};

const priorityColors: Record<number, string> = {
  10: "red",
  9: "red",
  8: "yellow",
  7: "yellow",
  6: "cyan",
  5: "cyan",
  4: "blue",
  3: "blue",
  2: "gray",
  1: "gray",
};

// ============================================
// Main Kanban Board
// ============================================

export function PlanKanban({
  board,
  visible = true,
  onClose,
  onStepSelect,
  selectedStepId = null,
  compact = false,
  maxItemsPerColumn = 5,
}: PlanKanbanProps) {
  // Handle keyboard input
  useInput(
    (input, key) => {
      if (key.escape && onClose) {
        onClose();
      }
    },
    { isActive: visible }
  );

  if (!visible) return null;

  const columnWidth = compact ? 20 : 28;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      {/* Header */}
      <Box justifyContent="space-between" marginBottom={1}>
        <Text color="cyan" bold>
          {"\u2592"} Plan Kanban Board
        </Text>
        <Text color="gray" dimColor>
          [ESC] close
        </Text>
      </Box>

      {/* Column Headers */}
      <Box>
        <ColumnHeader title="Backlog" count={board.backlog.length} width={columnWidth} color="gray" />
        <ColumnHeader title="Ready" count={board.ready.length} width={columnWidth} color="yellow" />
        <ColumnHeader title="In Progress" count={board.inProgress.length} width={columnWidth} color="cyan" />
        <ColumnHeader title="Done" count={board.done.length} width={columnWidth} color="green" />
      </Box>

      {/* Column Content */}
      <Box>
        <KanbanColumn
          items={board.backlog}
          width={columnWidth}
          maxItems={maxItemsPerColumn}
          selectedId={selectedStepId}
          onSelect={onStepSelect}
          compact={compact}
        />
        <KanbanColumn
          items={board.ready}
          width={columnWidth}
          maxItems={maxItemsPerColumn}
          selectedId={selectedStepId}
          onSelect={onStepSelect}
          compact={compact}
        />
        <KanbanColumn
          items={board.inProgress}
          width={columnWidth}
          maxItems={maxItemsPerColumn}
          selectedId={selectedStepId}
          onSelect={onStepSelect}
          compact={compact}
        />
        <KanbanColumn
          items={board.done}
          width={columnWidth}
          maxItems={maxItemsPerColumn}
          selectedId={selectedStepId}
          onSelect={onStepSelect}
          compact={compact}
        />
      </Box>

      {/* Footer with stats */}
      <Box marginTop={1} justifyContent="space-between">
        <Text color="gray" dimColor>
          Total: {board.backlog.length + board.ready.length + board.inProgress.length + board.done.length} steps
        </Text>
        <Text color="gray" dimColor>
          Ready: {board.ready.length} | Active: {board.inProgress.length}
        </Text>
      </Box>
    </Box>
  );
}

// ============================================
// Column Components
// ============================================

interface ColumnHeaderProps {
  title: string;
  count: number;
  width: number;
  color: string;
}

function ColumnHeader({ title, count, width, color }: ColumnHeaderProps) {
  const padding = width - title.length - String(count).length - 3;

  return (
    <Box width={width} borderStyle="single" borderColor={color as any} paddingX={1}>
      <Text color={color as any} bold>
        {title}
      </Text>
      <Text color="gray">
        {" ".repeat(Math.max(0, padding))}
      </Text>
      <Text color={color as any}>
        ({count})
      </Text>
    </Box>
  );
}

interface KanbanColumnProps {
  items: ProactiveStep[];
  width: number;
  maxItems: number;
  selectedId: string | null;
  onSelect?: (stepId: string) => void;
  compact: boolean;
}

function KanbanColumn({
  items,
  width,
  maxItems,
  selectedId,
  onSelect,
  compact,
}: KanbanColumnProps) {
  const displayItems = items.slice(0, maxItems);
  const hiddenCount = items.length - maxItems;

  return (
    <Box
      flexDirection="column"
      width={width}
      borderStyle="single"
      borderColor="gray"
      minHeight={maxItems * (compact ? 2 : 3) + 2}
    >
      {displayItems.map((item) => (
        <KanbanCard
          key={item.id}
          step={item}
          isSelected={item.id === selectedId}
          onSelect={onSelect}
          compact={compact}
          width={width - 2}
        />
      ))}

      {items.length === 0 && (
        <Box paddingX={1}>
          <Text color="gray" dimColor>
            (empty)
          </Text>
        </Box>
      )}

      {hiddenCount > 0 && (
        <Box paddingX={1}>
          <Text color="gray" dimColor>
            +{hiddenCount} more...
          </Text>
        </Box>
      )}
    </Box>
  );
}

// ============================================
// Card Component
// ============================================

interface KanbanCardProps {
  step: ProactiveStep;
  isSelected: boolean;
  onSelect?: (stepId: string) => void;
  compact: boolean;
  width: number;
}

function KanbanCard({ step, isSelected, onSelect, compact, width }: KanbanCardProps) {
  const categoryColor = categoryColors[step.category] || "gray";
  const priorityColor = priorityColors[step.priority] || "gray";

  // Truncate description to fit width
  const maxDescLen = width - 4;
  const truncatedDesc =
    step.description.length > maxDescLen
      ? step.description.slice(0, maxDescLen - 3) + "..."
      : step.description;

  const cardStyle = isSelected
    ? { borderStyle: "double" as const, borderColor: "cyan" as const }
    : { borderStyle: undefined, borderColor: undefined };

  if (compact) {
    return (
      <Box paddingX={1} {...cardStyle}>
        <Text color={categoryColor as any}>
          {getCategoryIcon(step.category)}
        </Text>
        <Text color="white"> {truncatedDesc}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1} marginBottom={1} {...cardStyle}>
      {/* Category & Priority */}
      <Box justifyContent="space-between">
        <Text color={categoryColor as any}>
          {getCategoryIcon(step.category)} {step.category}
        </Text>
        <Text color={priorityColor as any}>
          P{step.priority}
        </Text>
      </Box>

      {/* Description */}
      <Text color="white">{truncatedDesc}</Text>

      {/* Confidence */}
      <Box>
        <Text color="gray" dimColor>
          {Math.round(step.confidence * 100)}% conf
        </Text>
      </Box>
    </Box>
  );
}

function getCategoryIcon(category: StepCategory): string {
  const icons: Record<StepCategory, string> = {
    exploration: "\u{1F50D}", // Magnifying glass
    modification: "\u270F",  // Pencil
    search: "\u{1F50E}",     // Search right
    git: "\u2387",           // Branch
    test: "\u2713",          // Check
    debug: "\u{1F41B}",      // Bug
    refactor: "\u21BB",      // Cycle
    documentation: "\u{1F4DD}", // Memo
  };
  return icons[category] || "\u25CF";
}

// ============================================
// Avenue Display Component
// ============================================

export function AvenueDisplay({
  avenues,
  activeAvenueId = null,
  onAvenueSelect,
  visible = true,
}: AvenueDisplayProps) {
  if (!visible || avenues.length === 0) return null;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1}>
      {/* Header */}
      <Box marginBottom={1}>
        <Text color="magenta" bold>
          {"\u2263"} Possible Avenues
        </Text>
        <Text color="gray" dimColor>
          {" "}({avenues.length} paths)
        </Text>
      </Box>

      {/* Avenue Cards */}
      {avenues.map((avenue, index) => (
        <AvenueCard
          key={avenue.id}
          avenue={avenue}
          index={index + 1}
          isActive={avenue.id === activeAvenueId}
          onSelect={onAvenueSelect}
        />
      ))}

      {/* Help */}
      <Box marginTop={1}>
        <Text color="gray" dimColor>
          Type to match avenue or use /avenue [number]
        </Text>
      </Box>
    </Box>
  );
}

interface AvenueCardProps {
  avenue: Avenue;
  index: number;
  isActive: boolean;
  onSelect?: (avenueId: string) => void;
}

function AvenueCard({ avenue, index, isActive, onSelect }: AvenueCardProps) {
  const categoryColor = getCategoryColor(avenue.category);
  const probabilityBar = generateProbabilityBar(avenue.probability, 10);

  return (
    <Box
      flexDirection="column"
      paddingX={1}
      marginBottom={1}
      borderStyle={isActive ? "double" : "single"}
      borderColor={isActive ? "green" : "gray"}
    >
      {/* Title row */}
      <Box justifyContent="space-between">
        <Box>
          <Text color="yellow">[{index}]</Text>
          <Text color={categoryColor as any} bold>
            {" "}{avenue.name}
          </Text>
        </Box>
        <Text color={categoryColor as any}>
          {avenue.category}
        </Text>
      </Box>

      {/* Description */}
      <Text color="white">{avenue.description}</Text>

      {/* Probability bar */}
      <Box>
        <Text color="gray">Likelihood: </Text>
        <Text color="green">{probabilityBar}</Text>
        <Text color="gray"> {Math.round(avenue.probability * 100)}%</Text>
      </Box>

      {/* Steps count */}
      <Text color="gray" dimColor>
        {avenue.plan.steps.length} steps planned, ~{Math.round(avenue.plan.estimatedTime / 60)}min
      </Text>
    </Box>
  );
}

function getCategoryColor(category: Avenue["category"]): string {
  const colors: Record<string, string> = {
    feature: "green",
    bugfix: "red",
    refactor: "yellow",
    explore: "cyan",
    test: "blue",
    deploy: "magenta",
    config: "white",
    docs: "gray",
  };
  return colors[category] || "gray";
}

function generateProbabilityBar(probability: number, width: number): string {
  const filled = Math.round(probability * width);
  const empty = width - filled;
  return "\u2588".repeat(filled) + "\u2591".repeat(empty);
}

// ============================================
// Predicted Steps Component
// ============================================

export function PredictedSteps({
  steps,
  visible = true,
  onStepAccept,
  maxItems = 5,
}: PredictedStepsProps) {
  if (!visible || steps.length === 0) return null;

  const displaySteps = steps.slice(0, maxItems);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="green" paddingX={1}>
      {/* Header */}
      <Box marginBottom={1}>
        <Text color="green" bold>
          {"\u25B6"} Predicted Next Steps
        </Text>
      </Box>

      {/* Steps */}
      {displaySteps.map((step, index) => (
        <PredictedStepCard
          key={step.id}
          step={step}
          index={index + 1}
          onAccept={onStepAccept}
        />
      ))}

      {steps.length > maxItems && (
        <Text color="gray" dimColor>
          +{steps.length - maxItems} more predictions...
        </Text>
      )}

      {/* Help */}
      <Box marginTop={1}>
        <Text color="gray" dimColor>
          Press [Tab] on input to accept top prediction
        </Text>
      </Box>
    </Box>
  );
}

interface PredictedStepCardProps {
  step: ProactiveStep;
  index: number;
  onAccept?: (stepId: string) => void;
}

function PredictedStepCard({ step, index, onAccept }: PredictedStepCardProps) {
  const categoryColor = categoryColors[step.category] || "gray";
  const confidenceBar = generateProbabilityBar(step.confidence, 5);

  return (
    <Box paddingX={1} marginBottom={0}>
      <Text color="yellow">[{index}]</Text>
      <Text color={categoryColor as any}>
        {" "}{getCategoryIcon(step.category)}
      </Text>
      <Text color="white"> {step.description}</Text>
      <Text color="gray" dimColor>
        {" "}{confidenceBar}
      </Text>
    </Box>
  );
}

// ============================================
// Mini Kanban (Inline Version)
// ============================================

export interface MiniKanbanProps {
  board: KanbanBoard;
  width?: number;
}

export function MiniKanban({ board, width = 60 }: MiniKanbanProps) {
  const total =
    board.backlog.length + board.ready.length + board.inProgress.length + board.done.length;

  if (total === 0) {
    return (
      <Text color="gray" dimColor>
        No planned steps
      </Text>
    );
  }

  const colWidth = Math.floor((width - 7) / 4);

  return (
    <Box>
      <Text color="gray">[</Text>
      <MiniColumn items={board.backlog} label="B" color="gray" width={colWidth} />
      <Text color="gray">|</Text>
      <MiniColumn items={board.ready} label="R" color="yellow" width={colWidth} />
      <Text color="gray">|</Text>
      <MiniColumn items={board.inProgress} label="P" color="cyan" width={colWidth} />
      <Text color="gray">|</Text>
      <MiniColumn items={board.done} label="D" color="green" width={colWidth} />
      <Text color="gray">]</Text>
    </Box>
  );
}

function MiniColumn({
  items,
  label,
  color,
  width,
}: {
  items: ProactiveStep[];
  label: string;
  color: string;
  width: number;
}) {
  const dots = items.length > 0 ? "\u25CF".repeat(Math.min(items.length, width - 2)) : "\u00B7";

  return (
    <Box width={width}>
      <Text color={color as any}>{label}:</Text>
      <Text color={color as any}>{dots}</Text>
    </Box>
  );
}
