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
import { AppText, MutedText, Heading, Label, ErrorText, SuccessText, WarningText, Badge, StatusDot, Card, Stack, Inline, Divider } from './primitives/index.js';
import { formatBytes as formatBytesLib } from '../lib/index.js';

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
    <Card borderColor="cyan">
      {/* Header */}
      <Inline justifyContent="space-between">
        <Heading>
          {title}
        </Heading>
        <MutedText>
          <SuccessText>{stats.verified}</SuccessText>
          <AppText>/</AppText>
          <AppText>{stats.total}</AppText>
          <AppText> verified</AppText>
        </MutedText>
      </Inline>

      {/* Confidence meter if report provided */}
      {report && (
        <Box marginY={1}>
          <ConfidenceMeter confidence={report.confidence} showLabel />
        </Box>
      )}

      {/* Evidence list */}
      <Stack height={maxHeight}>
        {evidence.length === 0 ? (
          <MutedText italic>
            No evidence collected yet.
          </MutedText>
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
      </Stack>

      {/* Summary by type */}
      {Object.keys(groupedEvidence).length > 0 && (
        <Inline marginTop={1} flexWrap="wrap">
          {Object.entries(groupedEvidence).map(([type, items]) => {
            const verified = items.filter((e) => e.verified).length;
            return (
              <Inline key={type} marginRight={2} gap={0}>
                <MutedText>{type}: </MutedText>
                <Text color={verified === items.length ? "green" : "yellow"}>
                  {verified}/{items.length}
                </Text>
              </Inline>
            );
          })}
        </Inline>
      )}

      {/* Navigation hint */}
      <Box marginTop={1}>
        <MutedText>
          ↑↓ navigate • Enter to expand • q to close
        </MutedText>
      </Box>
    </Card>
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
    <SuccessText>✓</SuccessText>
  ) : (
    <ErrorText>✗</ErrorText>
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
    <Stack>
      <Inline gap={0}>
        {isSelected && <Text color="cyan">{"> "}</Text>}
        {!isSelected && <AppText>{"  "}</AppText>}
        {icon}
        <AppText> </AppText>
        <Badge label={evidence.type} color={typeColor} variant="outline" />
        <AppText> </AppText>
        <AppText wrap="truncate">{evidence.description}</AppText>
      </Inline>

      {/* Expanded details */}
      {isExpanded && (
        <Box
          flexDirection="column"
          marginLeft={4}
          paddingLeft={1}
          borderStyle="single"
          borderColor="blue"
          borderLeft
          borderRight={false}
          borderTop={false}
          borderBottom={false}
        >
          {evidence.path && (
            <MutedText>
              Path: <Label>{evidence.path}</Label>
            </MutedText>
          )}
          {evidence.command && (
            <MutedText>
              Command: <Label>{evidence.command}</Label>
            </MutedText>
          )}
          {evidence.exitCode !== undefined && (
            <MutedText>
              Exit code:{" "}
              {evidence.exitCode === 0
                ? <SuccessText>{evidence.exitCode}</SuccessText>
                : <ErrorText>{evidence.exitCode}</ErrorText>
              }
            </MutedText>
          )}
          {evidence.size !== undefined && (
            <MutedText>
              Size: <Label>{formatBytesLib(evidence.size)}</Label>
            </MutedText>
          )}
          {evidence.duration !== undefined && (
            <MutedText>
              Duration: <Label>{evidence.duration}ms</Label>
            </MutedText>
          )}
          {evidence.hash && (
            <MutedText>
              Hash: <MutedText>{evidence.hash}</MutedText>
            </MutedText>
          )}

          {/* Data preview */}
          <Box marginTop={1}>
            <MutedText>Data: </MutedText>
            <EvidenceDataPreview data={evidence.data} />
          </Box>
        </Box>
      )}
    </Stack>
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
    return data ? <SuccessText>{String(data)}</SuccessText> : <ErrorText>{String(data)}</ErrorText>;
  }

  if (typeof data === "string") {
    const preview = data.split("\n")[0].slice(0, 60);
    return (
      <MutedText wrap="truncate">
        "{preview}..."
      </MutedText>
    );
  }

  if (typeof data === "object") {
    try {
      const preview = JSON.stringify(data).slice(0, 60);
      return (
        <MutedText wrap="truncate">
          {preview}...
        </MutedText>
      );
    } catch {
      return <MutedText>[object]</MutedText>;
    }
  }

  return <MutedText>-</MutedText>;
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
    <Inline gap={0}>
      {showLabel && (
        <MutedText>Confidence: </MutedText>
      )}
      <Text color={color as any}>{confidence}%</Text>
      <AppText> </AppText>
      <Text color={color as any}>{"█".repeat(filled)}</Text>
      <MutedText>{"░".repeat(empty)}</MutedText>
    </Inline>
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
    <Card borderColor="blue">
      {/* Header */}
      <Inline justifyContent="space-between">
        <Label color="blue">
          Steps
        </Label>
        <Inline gap={0}>
          <SuccessText>{stats.passed}</SuccessText>
          <AppText>/</AppText>
          <AppText>{stats.total}</AppText>
          {stats.failed > 0 && (
            <>
              <AppText> </AppText>
              <ErrorText>({stats.failed} failed)</ErrorText>
            </>
          )}
        </Inline>
      </Inline>

      {/* Step list */}
      <Stack marginTop={1}>
        {steps.map((step, index) => {
          const isSelected = index === selectedIndex;
          const statusIcon =
            step.status === "passed" ? (
              <StatusDot status="success" />
            ) : step.status === "failed" ? (
              <StatusDot status="error" />
            ) : step.status === "skipped" ? (
              <StatusDot status="idle" />
            ) : (
              <StatusDot status="warning" />
            );

          return (
            <Inline key={step.stepId} gap={0}>
              {isSelected && <Text color="blue">{"> "}</Text>}
              {!isSelected && <AppText>{"  "}</AppText>}
              {statusIcon}
              <AppText> </AppText>
              <MutedText>[{step.stepId}]</MutedText>
              <AppText> </AppText>
              <AppText wrap="truncate">{step.action.slice(0, 40)}</AppText>
              {step.duration && (
                <MutedText> ({step.duration}ms)</MutedText>
              )}
            </Inline>
          );
        })}
      </Stack>
    </Card>
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
    <Stack padding={1}>
      {/* Tabs */}
      <Inline marginBottom={1}>
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
      </Inline>

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
    </Stack>
  );
}

function Tab({
  label,
  active,
}: {
  label: string;
  active: boolean;
}): React.ReactElement {
  if (active) {
    return (
      <Box marginRight={2}>
        <Badge label={label} color="cyan" />
      </Box>
    );
  }
  return (
    <Box marginRight={2}>
      <AppText>{` ${label} `}</AppText>
    </Box>
  );
}

function SummaryTab({
  report,
}: {
  report: ValidationReport;
}): React.ReactElement {
  return (
    <Card borderColor="cyan">
      <Heading>
        Validation Summary
      </Heading>

      <Box marginY={1}>
        <ConfidenceMeter confidence={report.confidence} showLabel />
      </Box>

      <AppText>{report.summary}</AppText>

      <Inline marginTop={1} gap={0}>
        <MutedText>Steps: </MutedText>
        <SuccessText>{report.passedSteps}</SuccessText>
        <AppText>/</AppText>
        <AppText>{report.totalSteps}</AppText>
        <AppText> passed</AppText>
        {report.failedSteps > 0 && (
          <>
            <AppText>, </AppText>
            <ErrorText>{report.failedSteps}</ErrorText>
            <AppText> failed</AppText>
          </>
        )}
      </Inline>

      <Inline gap={0}>
        <MutedText>Evidence: </MutedText>
        <AppText>{report.evidence.filter((e: Evidence) => e.verified).length}</AppText>
        <AppText>/</AppText>
        <AppText>{report.evidence.length}</AppText>
        <AppText> verified</AppText>
      </Inline>

      {report.duration && (
        <Inline marginTop={1} gap={0}>
          <MutedText>Duration: </MutedText>
          <AppText>{(report.duration / 1000).toFixed(1)}s</AppText>
        </Inline>
      )}

      {/* Warnings */}
      {report.warnings.length > 0 && (
        <Stack marginTop={1}>
          <Label color="yellow">
            Warnings:
          </Label>
          {report.warnings.map((warning: string, i: number) => (
            <WarningText key={i}>
              ⚠ {warning}
            </WarningText>
          ))}
        </Stack>
      )}

      {/* Suggestions */}
      {report.suggestions.length > 0 && (
        <Stack marginTop={1}>
          <Heading>
            Suggestions:
          </Heading>
          {report.suggestions.map((suggestion: string, i: number) => (
            <MutedText key={i}>
              💡 {suggestion}
            </MutedText>
          ))}
        </Stack>
      )}
    </Card>
  );
}

// ============================================
// Exports
// ============================================

export default EvidencePanel;
