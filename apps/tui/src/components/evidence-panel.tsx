/**
 * 8gent Code - Evidence Panel Component
 *
 * TUI component for displaying collected evidence for the current task.
 * Shows verification status with visual indicators:
 * - Green checkmarks for verified evidence
 * - Red X for failed validations
 * - Expandable details for each evidence item
 */

import React, { useState, useMemo } from "react";
import { Box, Text, useInput } from "ink";

// ============================================
// Types (inline to avoid import path issues)
// ============================================

type EvidenceType =
  | "file_exists"
  | "file_content"
  | "command_output"
  | "screenshot"
  | "diff"
  | "test_result"
  | "git_commit"
  | "git_status"
  | "directory_listing"
  | "json_content"
  | "error_log";

interface Evidence {
  type: EvidenceType;
  description: string;
  data: string | object | boolean;
  timestamp: Date;
  verified: boolean;
  path?: string;
  command?: string;
  exitCode?: number;
  duration?: number;
  size?: number;
  hash?: string;
}

interface StepReport {
  stepId: string;
  action: string;
  expected: string;
  actual?: string;
  status: "passed" | "failed" | "skipped" | "pending";
  evidence: Evidence[];
  confidence: number;
  duration?: number;
  error?: string;
}

interface ValidationReport {
  planId: string;
  totalSteps: number;
  passedSteps: number;
  failedSteps: number;
  skippedSteps: number;
  evidence: Evidence[];
  summary: string;
  confidence: number;
  timestamp: Date;
  duration?: number;
  steps: StepReport[];
  warnings: string[];
  suggestions: string[];
}

// ============================================
// Types
// ============================================

interface EvidencePanelProps {
  evidence: Evidence[];
  report?: ValidationReport;
  title?: string;
  maxHeight?: number;
  showDetails?: boolean;
  onSelect?: (evidence: Evidence) => void;
}

interface EvidenceItemProps {
  evidence: Evidence;
  isSelected: boolean;
  isExpanded: boolean;
}

interface StepPanelProps {
  steps: StepReport[];
  onStepSelect?: (step: StepReport) => void;
}

interface ConfidenceMeterProps {
  confidence: number;
  width?: number;
  showLabel?: boolean;
}

// ============================================
// Evidence Panel Component
// ============================================

export function EvidencePanel({
  evidence,
  report,
  title = "Evidence",
  maxHeight = 15,
  showDetails = true,
  onSelect,
}: EvidencePanelProps): React.ReactElement {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);

  // Navigate with arrow keys
  useInput((input, key) => {
    if (key.upArrow && selectedIndex > 0) {
      setSelectedIndex(selectedIndex - 1);
    }
    if (key.downArrow && selectedIndex < evidence.length - 1) {
      setSelectedIndex(selectedIndex + 1);
    }
    if (key.return) {
      if (expandedIndex === selectedIndex) {
        setExpandedIndex(null);
      } else {
        setExpandedIndex(selectedIndex);
        onSelect?.(evidence[selectedIndex]);
      }
    }
  });

  // Group evidence by type
  const groupedEvidence = useMemo(() => {
    const groups: Record<string, Evidence[]> = {};
    for (const ev of evidence) {
      if (!groups[ev.type]) groups[ev.type] = [];
      groups[ev.type].push(ev);
    }
    return groups;
  }, [evidence]);

  // Calculate stats
  const stats = useMemo(() => {
    const verified = evidence.filter((e) => e.verified).length;
    const failed = evidence.filter((e) => !e.verified).length;
    return { total: evidence.length, verified, failed };
  }, [evidence]);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      {/* Header */}
      <Box justifyContent="space-between">
        <Text bold color="cyan">
          {title}
        </Text>
        <Text dimColor>
          <Text color="green">{stats.verified}</Text>
          <Text>/</Text>
          <Text>{stats.total}</Text>
          <Text> verified</Text>
        </Text>
      </Box>

      {/* Confidence meter if report provided */}
      {report && (
        <Box marginY={1}>
          <ConfidenceMeter confidence={report.confidence} showLabel />
        </Box>
      )}

      {/* Evidence list */}
      <Box flexDirection="column" height={maxHeight}>
        {evidence.length === 0 ? (
          <Text dimColor italic>
            No evidence collected yet.
          </Text>
        ) : (
          evidence.map((ev, index) => (
            <EvidenceItem
              key={`${ev.type}-${index}`}
              evidence={ev}
              isSelected={index === selectedIndex}
              isExpanded={index === expandedIndex}
            />
          ))
        )}
      </Box>

      {/* Summary by type */}
      {Object.keys(groupedEvidence).length > 0 && (
        <Box marginTop={1} flexWrap="wrap">
          {Object.entries(groupedEvidence).map(([type, items]) => {
            const verified = items.filter((e) => e.verified).length;
            return (
              <Box key={type} marginRight={2}>
                <Text dimColor>{type}: </Text>
                <Text color={verified === items.length ? "green" : "yellow"}>
                  {verified}/{items.length}
                </Text>
              </Box>
            );
          })}
        </Box>
      )}

      {/* Navigation hint */}
      <Box marginTop={1}>
        <Text dimColor>
          ↑↓ navigate • Enter to expand • q to close
        </Text>
      </Box>
    </Box>
  );
}

// ============================================
// Evidence Item Component
// ============================================

function EvidenceItem({
  evidence,
  isSelected,
  isExpanded,
}: EvidenceItemProps): React.ReactElement {
  const icon = evidence.verified ? (
    <Text color="green">✓</Text>
  ) : (
    <Text color="red">✗</Text>
  );

  const typeColors: Record<EvidenceType, string> = {
    file_exists: "cyan",
    file_content: "blue",
    command_output: "yellow",
    screenshot: "magenta",
    diff: "green",
    test_result: "greenBright",
    git_commit: "cyan",
    git_status: "cyan",
    directory_listing: "blue",
    json_content: "yellow",
    error_log: "red",
  };

  const typeColor = typeColors[evidence.type] || "white";

  return (
    <Box flexDirection="column">
      <Box>
        {isSelected && <Text color="cyan">{"> "}</Text>}
        {!isSelected && <Text>{"  "}</Text>}
        {icon}
        <Text> </Text>
        <Text color={typeColor as any}>[{evidence.type}]</Text>
        <Text> </Text>
        <Text wrap="truncate">{evidence.description}</Text>
      </Box>

      {/* Expanded details */}
      {isExpanded && (
        <Box
          flexDirection="column"
          marginLeft={4}
          paddingLeft={1}
          borderStyle="single"
          borderColor="gray"
          borderLeft
          borderRight={false}
          borderTop={false}
          borderBottom={false}
        >
          {evidence.path && (
            <Text dimColor>
              Path: <Text color="white">{evidence.path}</Text>
            </Text>
          )}
          {evidence.command && (
            <Text dimColor>
              Command: <Text color="white">{evidence.command}</Text>
            </Text>
          )}
          {evidence.exitCode !== undefined && (
            <Text dimColor>
              Exit code:{" "}
              <Text color={evidence.exitCode === 0 ? "green" : "red"}>
                {evidence.exitCode}
              </Text>
            </Text>
          )}
          {evidence.size !== undefined && (
            <Text dimColor>
              Size: <Text color="white">{formatBytes(evidence.size)}</Text>
            </Text>
          )}
          {evidence.duration !== undefined && (
            <Text dimColor>
              Duration: <Text color="white">{evidence.duration}ms</Text>
            </Text>
          )}
          {evidence.hash && (
            <Text dimColor>
              Hash: <Text color="gray">{evidence.hash}</Text>
            </Text>
          )}

          {/* Data preview */}
          <Box marginTop={1}>
            <Text dimColor>Data: </Text>
            <EvidenceDataPreview data={evidence.data} />
          </Box>
        </Box>
      )}
    </Box>
  );
}

// ============================================
// Evidence Data Preview Component
// ============================================

function EvidenceDataPreview({
  data,
}: {
  data: string | object | boolean;
}): React.ReactElement {
  if (typeof data === "boolean") {
    return <Text color={data ? "green" : "red"}>{String(data)}</Text>;
  }

  if (typeof data === "string") {
    const preview = data.split("\n")[0].slice(0, 60);
    return (
      <Text color="gray" wrap="truncate">
        "{preview}..."
      </Text>
    );
  }

  if (typeof data === "object") {
    try {
      const preview = JSON.stringify(data).slice(0, 60);
      return (
        <Text color="gray" wrap="truncate">
          {preview}...
        </Text>
      );
    } catch {
      return <Text color="gray">[object]</Text>;
    }
  }

  return <Text color="gray">-</Text>;
}

// ============================================
// Confidence Meter Component
// ============================================

export function ConfidenceMeter({
  confidence,
  width = 30,
  showLabel = true,
}: ConfidenceMeterProps): React.ReactElement {
  const filled = Math.round((confidence / 100) * width);
  const empty = width - filled;

  const color = confidence >= 80 ? "green" : confidence >= 50 ? "yellow" : "red";

  return (
    <Box>
      {showLabel && (
        <Text dimColor>Confidence: </Text>
      )}
      <Text color={color as any}>{confidence}%</Text>
      <Text> </Text>
      <Text color={color as any}>{"█".repeat(filled)}</Text>
      <Text dimColor>{"░".repeat(empty)}</Text>
    </Box>
  );
}

// ============================================
// Step Panel Component
// ============================================

export function StepPanel({
  steps,
  onStepSelect,
}: StepPanelProps): React.ReactElement {
  const [selectedIndex, setSelectedIndex] = useState(0);

  useInput((input, key) => {
    if (key.upArrow && selectedIndex > 0) {
      setSelectedIndex(selectedIndex - 1);
    }
    if (key.downArrow && selectedIndex < steps.length - 1) {
      setSelectedIndex(selectedIndex + 1);
    }
    if (key.return && onStepSelect) {
      onStepSelect(steps[selectedIndex]);
    }
  });

  // Calculate stats
  const stats = useMemo(() => {
    const passed = steps.filter((s) => s.status === "passed").length;
    const failed = steps.filter((s) => s.status === "failed").length;
    const skipped = steps.filter((s) => s.status === "skipped").length;
    return { total: steps.length, passed, failed, skipped };
  }, [steps]);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="blue" paddingX={1}>
      {/* Header */}
      <Box justifyContent="space-between">
        <Text bold color="blue">
          Steps
        </Text>
        <Box>
          <Text color="green">{stats.passed}</Text>
          <Text>/</Text>
          <Text>{stats.total}</Text>
          {stats.failed > 0 && (
            <>
              <Text> </Text>
              <Text color="red">({stats.failed} failed)</Text>
            </>
          )}
        </Box>
      </Box>

      {/* Step list */}
      <Box flexDirection="column" marginTop={1}>
        {steps.map((step, index) => {
          const isSelected = index === selectedIndex;
          const statusIcon =
            step.status === "passed" ? (
              <Text color="green">●</Text>
            ) : step.status === "failed" ? (
              <Text color="red">✗</Text>
            ) : step.status === "skipped" ? (
              <Text dimColor>○</Text>
            ) : (
              <Text color="yellow">◐</Text>
            );

          return (
            <Box key={step.stepId}>
              {isSelected && <Text color="blue">{"> "}</Text>}
              {!isSelected && <Text>{"  "}</Text>}
              {statusIcon}
              <Text> </Text>
              <Text dimColor>[{step.stepId}]</Text>
              <Text> </Text>
              <Text wrap="truncate">{step.action.slice(0, 40)}</Text>
              {step.duration && (
                <Text dimColor> ({step.duration}ms)</Text>
              )}
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}

// ============================================
// Validation Report Panel Component
// ============================================

export function ValidationReportPanel({
  report,
}: {
  report: ValidationReport;
}): React.ReactElement {
  const [activeTab, setActiveTab] = useState<"steps" | "evidence" | "summary">("summary");

  useInput((input) => {
    if (input === "1") setActiveTab("summary");
    if (input === "2") setActiveTab("steps");
    if (input === "3") setActiveTab("evidence");
  });

  return (
    <Box flexDirection="column" padding={1}>
      {/* Tabs */}
      <Box marginBottom={1}>
        <Tab
          label="1. Summary"
          active={activeTab === "summary"}
        />
        <Tab
          label="2. Steps"
          active={activeTab === "steps"}
        />
        <Tab
          label="3. Evidence"
          active={activeTab === "evidence"}
        />
      </Box>

      {/* Tab content */}
      {activeTab === "summary" && (
        <SummaryTab report={report} />
      )}
      {activeTab === "steps" && (
        <StepPanel steps={report.steps} />
      )}
      {activeTab === "evidence" && (
        <EvidencePanel evidence={report.evidence} />
      )}
    </Box>
  );
}

function Tab({
  label,
  active,
}: {
  label: string;
  active: boolean;
}): React.ReactElement {
  return (
    <Box marginRight={2}>
      <Text
        bold={active}
        color={active ? "cyan" : undefined}
        inverse={active}
      >
        {` ${label} `}
      </Text>
    </Box>
  );
}

function SummaryTab({
  report,
}: {
  report: ValidationReport;
}): React.ReactElement {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">
        Validation Summary
      </Text>

      <Box marginY={1}>
        <ConfidenceMeter confidence={report.confidence} showLabel />
      </Box>

      <Text>{report.summary}</Text>

      <Box marginTop={1}>
        <Text dimColor>Steps: </Text>
        <Text color="green">{report.passedSteps}</Text>
        <Text>/</Text>
        <Text>{report.totalSteps}</Text>
        <Text> passed</Text>
        {report.failedSteps > 0 && (
          <>
            <Text>, </Text>
            <Text color="red">{report.failedSteps}</Text>
            <Text> failed</Text>
          </>
        )}
      </Box>

      <Box>
        <Text dimColor>Evidence: </Text>
        <Text>{report.evidence.filter((e: Evidence) => e.verified).length}</Text>
        <Text>/</Text>
        <Text>{report.evidence.length}</Text>
        <Text> verified</Text>
      </Box>

      {report.duration && (
        <Box marginTop={1}>
          <Text dimColor>Duration: </Text>
          <Text>{(report.duration / 1000).toFixed(1)}s</Text>
        </Box>
      )}

      {/* Warnings */}
      {report.warnings.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold color="yellow">
            Warnings:
          </Text>
          {report.warnings.map((warning: string, i: number) => (
            <Text key={i} color="yellow">
              ⚠ {warning}
            </Text>
          ))}
        </Box>
      )}

      {/* Suggestions */}
      {report.suggestions.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold color="cyan">
            Suggestions:
          </Text>
          {report.suggestions.map((suggestion: string, i: number) => (
            <Text key={i} dimColor>
              💡 {suggestion}
            </Text>
          ))}
        </Box>
      )}
    </Box>
  );
}

// ============================================
// Helper Functions
// ============================================

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ============================================
// Exports
// ============================================

export default EvidencePanel;
