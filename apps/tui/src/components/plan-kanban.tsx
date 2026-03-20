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
import { AppText, MutedText, Heading, Label, Badge, StatusDot, Card, Stack, Inline, Spacer, Divider } from './primitives/index.js';
import { truncate } from '../lib/index.js';

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
  refactor: "cyan",
  documentation: "blue",
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
  2: "blue",
  1: "blue",
};

// ============================================
// Auto-Kanban Types (from useAutoKanban hook)
// ============================================

export interface AutoKanbanCard {
  id: string;
  title: string;
  description: string;
  status: "backlog" | "ready" | "in-progress" | "done" | "failed";
  assignedTo: string;
  assignedTabName: string;
  toolName?: string;
  toolCallId?: string;
  parentId?: string;
  startedAt?: number;
  completedAt?: number;
  durationMs?: number;
  icon: string;
}

export interface AutoKanbanColumns {
  backlog: AutoKanbanCard[];
  ready: AutoKanbanCard[];
  inProgress: AutoKanbanCard[];
  done: AutoKanbanCard[];
}

export interface AutoKanbanStats {
  total: number;
  active: number;
  done: number;
  failed: number;
}

export interface AutoPlanKanbanProps {
  columns: AutoKanbanColumns;
  stats: AutoKanbanStats;
  visible?: boolean;
  onClose?: () => void;
  compact?: boolean;
  maxItemsPerColumn?: number;
}

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

  // Min 16 chars for title + count, accounting for borders/padding
  const columnWidth = compact ? 16 : 24;

  return (
    <Card borderColor="cyan">
      {/* Header */}
      <Inline justifyContent="space-between" marginBottom={1}>
        <Heading>
          {"\u2592"} Plan Kanban Board
        </Heading>
        <MutedText>
          [ESC] close
        </MutedText>
      </Inline>

      {/* Column Headers */}
      <Inline gap={0}>
        <ColumnHeader title="Backlog" count={board.backlog.length} width={columnWidth} color="blue" />
        <ColumnHeader title="Ready" count={board.ready.length} width={columnWidth} color="yellow" />
        <ColumnHeader title="In Progress" count={board.inProgress.length} width={columnWidth} color="cyan" />
        <ColumnHeader title="Done" count={board.done.length} width={columnWidth} color="green" />
      </Inline>

      {/* Column Content */}
      <Inline gap={0}>
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
      </Inline>

      {/* Footer with stats */}
      <Inline justifyContent="space-between" marginTop={1}>
        <MutedText>
          Total: {board.backlog.length + board.ready.length + board.inProgress.length + board.done.length} steps
        </MutedText>
        <MutedText>
          Ready: {board.ready.length} | Active: {board.inProgress.length}
        </MutedText>
      </Inline>
    </Card>
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
  // Calculate available space for title (width - borders - padding - count display)
  const countStr = `(${count})`;
  const availableForTitle = width - 4 - countStr.length - 1; // borders(2) + paddingX(2) + space(1)
  const displayTitle = truncate(title, availableForTitle);

  return (
    <Box width={width} minWidth={width} flexShrink={0} borderStyle="single" borderColor={color as any} paddingX={1}>
      <Inline gap={0} justifyContent="space-between" flexGrow={1}>
        <Label color={color as any}>
          {displayTitle}
        </Label>
        <Badge label={countStr} color={color as any} variant="outline" />
      </Inline>
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
    <Stack
      width={width}
      borderStyle="single"
      borderColor="blue"
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
          <MutedText>
            (empty)
          </MutedText>
        </Box>
      )}

      {hiddenCount > 0 && (
        <Box paddingX={1}>
          <MutedText>
            +{hiddenCount} more...
          </MutedText>
        </Box>
      )}
    </Stack>
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
  const categoryColor = categoryColors[step.category] || "blue";
  const priorityColor = priorityColors[step.priority] || "blue";

  // Truncate description to fit width
  const maxDescLen = width - 4;
  const truncatedDesc = truncate(step.description, maxDescLen);

  const cardStyle = isSelected
    ? { borderStyle: "double" as const, borderColor: "cyan" as const }
    : { borderStyle: undefined, borderColor: undefined };

  if (compact) {
    return (
      <Inline gap={0} paddingX={1} {...cardStyle}>
        <AppText color={categoryColor as any}>
          {getCategoryIcon(step.category)}
        </AppText>
        <Label> {truncatedDesc}</Label>
      </Inline>
    );
  }

  return (
    <Stack paddingX={1} marginBottom={1} {...cardStyle}>
      {/* Category & Priority */}
      <Inline gap={0} justifyContent="space-between">
        <AppText color={categoryColor as any}>
          {getCategoryIcon(step.category)} {step.category}
        </AppText>
        <Badge label={`P${step.priority}`} color={priorityColor as any} variant="outline" />
      </Inline>

      {/* Description */}
      <Label>{truncatedDesc}</Label>

      {/* Confidence */}
      <MutedText>
        {Math.round(step.confidence * 100)}% conf
      </MutedText>
    </Stack>
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
    <Card borderColor="magenta">
      {/* Header */}
      <Inline gap={0} marginBottom={1}>
        <Heading color="magenta">
          {"\u2263"} Possible Avenues
        </Heading>
        <MutedText>
          {" "}({avenues.length} paths)
        </MutedText>
      </Inline>

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
        <MutedText>
          Type to match avenue or use /avenue [number]
        </MutedText>
      </Box>
    </Card>
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
    <Stack
      paddingX={1}
      marginBottom={1}
      borderStyle={isActive ? "double" : "single"}
      borderColor={isActive ? "green" : "blue"}
    >
      {/* Title row */}
      <Inline gap={0} justifyContent="space-between">
        <Inline gap={0}>
          <AppText color="yellow">[{index}]</AppText>
          <Label color={categoryColor as any}>
            {" "}{avenue.name}
          </Label>
        </Inline>
        <Badge label={avenue.category} color={categoryColor as any} variant="outline" />
      </Inline>

      {/* Description */}
      <Label>{avenue.description}</Label>

      {/* Probability bar */}
      <Inline gap={0}>
        <MutedText>Likelihood: </MutedText>
        <AppText color="green">{probabilityBar}</AppText>
        <MutedText> {Math.round(avenue.probability * 100)}%</MutedText>
      </Inline>

      {/* Steps count */}
      <MutedText>
        {avenue.plan.steps.length} steps planned, ~{Math.round(avenue.plan.estimatedTime / 60)}min
      </MutedText>
    </Stack>
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
    config: "cyan",
    docs: "blue",
  };
  return colors[category] || "blue";
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
    <Card borderColor="green">
      {/* Header */}
      <Box marginBottom={1}>
        <Heading color="green">
          {"\u25B6"} Predicted Next Steps
        </Heading>
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
        <MutedText>
          +{steps.length - maxItems} more predictions...
        </MutedText>
      )}

      {/* Help */}
      <Box marginTop={1}>
        <MutedText>
          Press [Tab] on input to accept top prediction
        </MutedText>
      </Box>
    </Card>
  );
}

interface PredictedStepCardProps {
  step: ProactiveStep;
  index: number;
  onAccept?: (stepId: string) => void;
}

function PredictedStepCard({ step, index, onAccept }: PredictedStepCardProps) {
  const categoryColor = categoryColors[step.category] || "blue";
  const confidenceBar = generateProbabilityBar(step.confidence, 5);

  return (
    <Inline gap={0} paddingX={1} marginBottom={0}>
      <AppText color="yellow">[{index}]</AppText>
      <AppText color={categoryColor as any}>
        {" "}{getCategoryIcon(step.category)}
      </AppText>
      <Label> {step.description}</Label>
      <MutedText>
        {" "}{confidenceBar}
      </MutedText>
    </Inline>
  );
}

// ============================================
// Auto-Populating Kanban Board (from real events)
// ============================================

export function AutoPlanKanban({
  columns,
  stats,
  visible = true,
  onClose,
  compact = false,
  maxItemsPerColumn = 5,
}: AutoPlanKanbanProps) {
  useInput(
    (input, key) => {
      if (key.escape && onClose) {
        onClose();
      }
    },
    { isActive: visible }
  );

  if (!visible) return null;

  const columnWidth = compact ? 16 : 26;

  return (
    <Card borderColor="cyan">
      {/* Header */}
      <Inline justifyContent="space-between" marginBottom={1}>
        <Heading>
          {"\u2592"} Task Board
        </Heading>
        <MutedText>
          [ESC] close
        </MutedText>
      </Inline>

      {/* Column Headers */}
      <Inline gap={0}>
        <ColumnHeader title="Backlog" count={columns.backlog.length} width={columnWidth} color="blue" />
        <ColumnHeader title="Ready" count={columns.ready.length} width={columnWidth} color="yellow" />
        <ColumnHeader title="In Progress" count={columns.inProgress.length} width={columnWidth} color="cyan" />
        <ColumnHeader title="Done" count={columns.done.length} width={columnWidth} color="green" />
      </Inline>

      {/* Column Content */}
      <Inline gap={0}>
        <AutoKanbanColumn items={columns.backlog} width={columnWidth} maxItems={maxItemsPerColumn} compact={compact} />
        <AutoKanbanColumn items={columns.ready} width={columnWidth} maxItems={maxItemsPerColumn} compact={compact} />
        <AutoKanbanColumn items={columns.inProgress} width={columnWidth} maxItems={maxItemsPerColumn} compact={compact} />
        <AutoKanbanColumn items={columns.done} width={columnWidth} maxItems={maxItemsPerColumn} compact={compact} />
      </Inline>

      {/* Footer with stats */}
      <Inline justifyContent="space-between" marginTop={1}>
        <MutedText>
          {stats.total} tasks
        </MutedText>
        <Inline gap={0}>
          <AppText color="cyan">{stats.active} active</AppText>
          <MutedText> {"\u00B7"} </MutedText>
          <AppText color="green">{stats.done} done</AppText>
          {stats.failed > 0 && (
            <>
              <MutedText> {"\u00B7"} </MutedText>
              <AppText color="red">{stats.failed} failed</AppText>
            </>
          )}
        </Inline>
      </Inline>
    </Card>
  );
}

// ============================================
// Auto-Kanban Column
// ============================================

interface AutoKanbanColumnProps {
  items: AutoKanbanCard[];
  width: number;
  maxItems: number;
  compact: boolean;
}

function AutoKanbanColumn({ items, width, maxItems, compact }: AutoKanbanColumnProps) {
  const displayItems = items.slice(0, maxItems);
  const hiddenCount = items.length - maxItems;

  return (
    <Stack
      width={width}
      borderStyle="single"
      borderColor="blue"
      minHeight={maxItems * (compact ? 2 : 3) + 2}
    >
      {displayItems.map((item) => (
        <AutoKanbanCardView
          key={item.id}
          card={item}
          compact={compact}
          width={width - 2}
        />
      ))}

      {items.length === 0 && (
        <Box paddingX={1}>
          <MutedText>
            (empty)
          </MutedText>
        </Box>
      )}

      {hiddenCount > 0 && (
        <Box paddingX={1}>
          <MutedText>
            +{hiddenCount} more...
          </MutedText>
        </Box>
      )}
    </Stack>
  );
}

// ============================================
// Auto-Kanban Card View
// ============================================

interface AutoKanbanCardViewProps {
  card: AutoKanbanCard;
  compact: boolean;
  width: number;
}

function AutoKanbanCardView({ card, compact, width }: AutoKanbanCardViewProps) {
  const statusColor = card.status === "done" ? "green"
    : card.status === "failed" ? "red"
    : card.status === "in-progress" ? "cyan"
    : card.status === "ready" ? "yellow"
    : "blue";

  const maxTitleLen = width - 4;
  const truncatedTitle = truncate(card.title, maxTitleLen);

  const durationStr = card.durationMs != null
    ? card.durationMs < 1000 ? `${card.durationMs}ms` : `${(card.durationMs / 1000).toFixed(1)}s`
    : null;

  if (compact) {
    return (
      <Inline gap={0} paddingX={1}>
        <AppText color={statusColor as any}>
          {card.icon}
        </AppText>
        <Label> {truncatedTitle}</Label>
      </Inline>
    );
  }

  return (
    <Stack paddingX={1} marginBottom={0}>
      {/* Icon + title */}
      <Inline gap={0}>
        <AppText color={statusColor as any}>
          {card.icon}{" "}
        </AppText>
        <Label>{truncatedTitle}</Label>
      </Inline>

      {/* Tab assignment + duration */}
      <Inline gap={0} justifyContent="space-between">
        <MutedText>
          [{truncate(card.assignedTabName, 12)}]
        </MutedText>
        {durationStr && (
          <MutedText>{durationStr}</MutedText>
        )}
        {card.status === "failed" && (
          <AppText color="red">{"\u2717"}</AppText>
        )}
      </Inline>
    </Stack>
  );
}

// ============================================
// Auto Mini Kanban (Inline Version for status bar)
// ============================================

export interface AutoMiniKanbanProps {
  columns: AutoKanbanColumns;
  stats: AutoKanbanStats;
  width?: number;
}

export function AutoMiniKanban({ columns, stats, width = 60 }: AutoMiniKanbanProps) {
  if (stats.total === 0) {
    return (
      <MutedText>
        No tasks
      </MutedText>
    );
  }

  const colWidth = Math.floor((width - 7) / 4);

  return (
    <Inline gap={0}>
      <MutedText>[</MutedText>
      <AutoMiniColumn items={columns.backlog} label="B" color="blue" width={colWidth} />
      <MutedText>|</MutedText>
      <AutoMiniColumn items={columns.ready} label="R" color="yellow" width={colWidth} />
      <MutedText>|</MutedText>
      <AutoMiniColumn items={columns.inProgress} label="P" color="cyan" width={colWidth} />
      <MutedText>|</MutedText>
      <AutoMiniColumn items={columns.done} label="D" color="green" width={colWidth} />
      <MutedText>]</MutedText>
    </Inline>
  );
}

function AutoMiniColumn({
  items,
  label,
  color,
  width,
}: {
  items: AutoKanbanCard[];
  label: string;
  color: string;
  width: number;
}) {
  const dots = items.length > 0 ? "\u25CF".repeat(Math.min(items.length, width - 2)) : "\u00B7";

  return (
    <Box width={width}>
      <AppText color={color as any}>{label}:</AppText>
      <AppText color={color as any}>{dots}</AppText>
    </Box>
  );
}

// ============================================
// Mini Kanban (Inline Version) — Legacy
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
      <MutedText>
        No planned steps
      </MutedText>
    );
  }

  const colWidth = Math.floor((width - 7) / 4);

  return (
    <Inline gap={0}>
      <MutedText>[</MutedText>
      <MiniColumn items={board.backlog} label="B" color="blue" width={colWidth} />
      <MutedText>|</MutedText>
      <MiniColumn items={board.ready} label="R" color="yellow" width={colWidth} />
      <MutedText>|</MutedText>
      <MiniColumn items={board.inProgress} label="P" color="cyan" width={colWidth} />
      <MutedText>|</MutedText>
      <MiniColumn items={board.done} label="D" color="green" width={colWidth} />
      <MutedText>]</MutedText>
    </Inline>
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
      <AppText color={color as any}>{label}:</AppText>
      <AppText color={color as any}>{dots}</AppText>
    </Box>
  );
}
