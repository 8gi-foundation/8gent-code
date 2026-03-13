/**
 * 8gent Code - Completion Report Component
 *
 * Beautiful TUI component for displaying task completion reports.
 * Features:
 * - Animated reveal (fade in sections)
 * - Expandable sections
 * - Color-coded status
 * - Copy support
 */

import React, { useState, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import Gradient from "ink-gradient";
import { AppText, MutedText, Heading, Label, ErrorText, SuccessText, WarningText, Badge, StatusDot, Card, Stack, Inline, Divider } from './primitives/index.js';
import { formatDuration as formatDurationLib, formatTokens } from '../lib/index.js';

// ============================================
// Types
// ============================================

interface StepSummary {
  index: number;
  description: string;
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  duration?: number;
  toolsUsed?: string[];
  filesAffected?: string[];
  error?: string;
}

interface EvidenceSummary {
  type: string;
  label: string;
  status: "pass" | "fail" | "pending" | "skipped";
  details?: string;
  url?: string;
}

interface CompletionReportData {
  id: string;
  summary: string;
  filesCreated: string[];
  filesModified: string[];
  filesDeleted: string[];
  toolsUsed: number;
  tokensUsed?: number;
  tokensSaved?: number;
  duration: string;
  steps: StepSummary[];
  evidence: EvidenceSummary[];
  gitCommit?: string;
  gitBranch?: string;
  confidence: number;
  status: "success" | "partial" | "failed";
  error?: string;
}

interface CompletionReportProps {
  report: CompletionReportData;
  animate?: boolean;
  onClose?: () => void;
  onCopy?: (text: string) => void;
}

// ============================================
// Box Characters
// ============================================

const boxChars = {
  doubleTopLeft: "\u2554",
  doubleTopRight: "\u2557",
  doubleBottomLeft: "\u255A",
  doubleBottomRight: "\u255D",
  doubleHorizontal: "\u2550",
  doubleVertical: "\u2551",
  singleHorizontal: "\u2500",
  treeMiddle: "\u251C",
  treeLast: "\u2514",
  checkmark: "\u2713",
  crossmark: "\u2717",
  bullet: "\u2022",
  arrowRight: "\u25B8",
  circle: "\u25CF",
  emptyCircle: "\u25CB",
};

// ============================================
// Main Component
// ============================================

export function CompletionReport({
  report,
  animate = true,
  onClose,
  onCopy,
}: CompletionReportProps) {
  const [revealedSections, setRevealedSections] = useState(animate ? 0 : 10);
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set(["steps", "evidence"]));
  const [copied, setCopied] = useState(false);

  // Animated reveal effect
  useEffect(() => {
    if (!animate || revealedSections >= 10) return;

    const timeout = setTimeout(() => {
      setRevealedSections(prev => prev + 1);
    }, 100);

    return () => clearTimeout(timeout);
  }, [animate, revealedSections]);

  // Keyboard input
  useInput((input, key) => {
    if (key.escape && onClose) {
      onClose();
    }

    if (input === "c" && onCopy) {
      const text = formatReportAsText(report);
      onCopy(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }

    if (input === "1") toggleSection("files");
    if (input === "2") toggleSection("steps");
    if (input === "3") toggleSection("evidence");
    if (input === "4") toggleSection("stats");
  });

  const toggleSection = (section: string) => {
    setExpandedSections(prev => {
      const next = new Set(prev);
      if (next.has(section)) {
        next.delete(section);
      } else {
        next.add(section);
      }
      return next;
    });
  };

  const isExpanded = (section: string) => expandedSections.has(section);

  return (
    <Stack paddingX={1}>
      {/* Status Banner */}
      {revealedSections >= 1 && <StatusBanner status={report.status} />}

      {/* Summary */}
      {revealedSections >= 2 && (
        <Section title="Summary">
          <AppText wrap="wrap">{report.summary}</AppText>
        </Section>
      )}

      {/* Files Section */}
      {revealedSections >= 3 && (report.filesCreated.length > 0 || report.filesModified.length > 0) && (
        <CollapsibleSection
          title={`Files (${report.filesCreated.length + report.filesModified.length})`}
          expanded={isExpanded("files")}
          onToggle={() => toggleSection("files")}
          hotkey="1"
        >
          {report.filesCreated.length > 0 && (
            <Stack marginBottom={1}>
              <Label color="green">Created ({report.filesCreated.length})</Label>
              {report.filesCreated.map((file, i) => (
                <SuccessText key={i}>  {boxChars.bullet} {file}</SuccessText>
              ))}
            </Stack>
          )}
          {report.filesModified.length > 0 && (
            <Stack>
              <Label color="yellow">Modified ({report.filesModified.length})</Label>
              {report.filesModified.map((file, i) => (
                <WarningText key={i}>  {boxChars.bullet} {file}</WarningText>
              ))}
            </Stack>
          )}
        </CollapsibleSection>
      )}

      {/* Steps Section */}
      {revealedSections >= 4 && report.steps.length > 0 && (
        <CollapsibleSection
          title={`Steps (${report.steps.filter(s => s.status === "completed").length}/${report.steps.length})`}
          expanded={isExpanded("steps")}
          onToggle={() => toggleSection("steps")}
          hotkey="2"
        >
          {report.steps.map((step, i) => (
            <StepItem key={i} step={step} />
          ))}
        </CollapsibleSection>
      )}

      {/* Evidence Section */}
      {revealedSections >= 5 && report.evidence.length > 0 && (
        <CollapsibleSection
          title={`Evidence (${report.evidence.filter(e => e.status === "pass").length}/${report.evidence.length})`}
          expanded={isExpanded("evidence")}
          onToggle={() => toggleSection("evidence")}
          hotkey="3"
        >
          {report.evidence.map((evidence, i) => (
            <EvidenceItem key={i} evidence={evidence} isLast={i === report.evidence.length - 1} />
          ))}
        </CollapsibleSection>
      )}

      {/* Stats Section */}
      {revealedSections >= 6 && (
        <CollapsibleSection
          title="Stats"
          expanded={isExpanded("stats")}
          onToggle={() => toggleSection("stats")}
          hotkey="4"
        >
          <StatsGrid report={report} />
        </CollapsibleSection>
      )}

      {/* Divider */}
      {revealedSections >= 7 && (
        <Box marginTop={1}>
          <Divider />
        </Box>
      )}

      {/* Help text */}
      {revealedSections >= 8 && (
        <Box marginTop={1}>
          <MutedText>
            [1-4] toggle sections | [c] copy | [esc] close
            {copied && <SuccessText> Copied!</SuccessText>}
          </MutedText>
        </Box>
      )}
    </Stack>
  );
}

// ============================================
// Sub Components
// ============================================

function StatusBanner({ status }: { status: CompletionReportData["status"] }) {
  const config = {
    success: { text: "TASK COMPLETE", color: "green" as const, icon: boxChars.checkmark },
    partial: { text: "PARTIALLY COMPLETE", color: "yellow" as const, icon: "~" },
    failed: { text: "TASK FAILED", color: "red" as const, icon: boxChars.crossmark },
  };

  const { text, color, icon } = config[status];

  const width = 60;
  const innerText = `  ${icon} ${text}  `;
  const padding = Math.floor((width - innerText.length) / 2);

  return (
    <Stack marginBottom={1}>
      <Text color={color}>{boxChars.doubleTopLeft}{boxChars.doubleHorizontal.repeat(width)}{boxChars.doubleTopRight}</Text>
      <Text color={color}>
        {boxChars.doubleVertical}
        {" ".repeat(padding)}
        <Label>{innerText}</Label>
        {" ".repeat(width - padding - innerText.length)}
        {boxChars.doubleVertical}
      </Text>
      <Text color={color}>{boxChars.doubleBottomLeft}{boxChars.doubleHorizontal.repeat(width)}{boxChars.doubleBottomRight}</Text>
    </Stack>
  );
}

interface SectionProps {
  title: string;
  children: React.ReactNode;
}

function Section({ title, children }: SectionProps) {
  return (
    <Stack marginBottom={1}>
      <Heading>{title}</Heading>
      <Stack marginLeft={2}>
        {children}
      </Stack>
    </Stack>
  );
}

interface CollapsibleSectionProps {
  title: string;
  children: React.ReactNode;
  expanded: boolean;
  onToggle: () => void;
  hotkey?: string;
}

function CollapsibleSection({ title, children, expanded, onToggle, hotkey }: CollapsibleSectionProps) {
  const icon = expanded ? "\u25BC" : "\u25B6";

  return (
    <Stack marginBottom={1}>
      <Inline gap={0}>
        <Heading>{icon} {title}</Heading>
        {hotkey && <MutedText> [{hotkey}]</MutedText>}
      </Inline>
      {expanded && (
        <Stack marginLeft={2}>
          {children}
        </Stack>
      )}
    </Stack>
  );
}

function StepItem({ step }: { step: StepSummary }) {
  const statusConfig = {
    completed: { color: "green" as const, icon: boxChars.checkmark },
    failed: { color: "red" as const, icon: boxChars.crossmark },
    running: { color: "cyan" as const, icon: boxChars.arrowRight },
    skipped: { color: "yellow" as const, icon: "-" },
    pending: { color: "gray" as const, icon: boxChars.emptyCircle },
  };

  const { color, icon } = statusConfig[step.status];
  const duration = step.duration ? formatDurationLib(step.duration) : "";

  return (
    <Inline gap={0}>
      <Text color={color}>{step.index}. {icon} </Text>
      <AppText>{step.description}</AppText>
      {duration && <MutedText> ({duration})</MutedText>}
    </Inline>
  );
}

function EvidenceItem({ evidence, isLast }: { evidence: EvidenceSummary; isLast: boolean }) {
  const statusConfig = {
    pass: { color: "green" as const, icon: boxChars.checkmark },
    fail: { color: "red" as const, icon: boxChars.crossmark },
    pending: { color: "yellow" as const, icon: "?" },
    skipped: { color: "gray" as const, icon: "-" },
  };

  const { color, icon } = statusConfig[evidence.status];
  const connector = isLast ? boxChars.treeLast : boxChars.treeMiddle;

  return (
    <Inline gap={0}>
      <MutedText>{connector}{boxChars.singleHorizontal}{boxChars.singleHorizontal} </MutedText>
      <AppText>{evidence.label}: </AppText>
      <Text color={color}>{icon}</Text>
      {evidence.details && <MutedText> {evidence.details}</MutedText>}
      {evidence.url && <Text color="cyan"> {evidence.url}</Text>}
    </Inline>
  );
}

function StatsGrid({ report }: { report: CompletionReportData }) {
  const stats = [
    { label: "Tools used", value: String(report.toolsUsed), color: "cyan" as const },
    { label: "Duration", value: report.duration, color: "yellow" as const },
    { label: "Confidence", value: `${report.confidence}%`, color: report.confidence >= 80 ? "green" as const : report.confidence >= 50 ? "yellow" as const : "red" as const },
  ];

  if (report.tokensUsed) {
    stats.push({ label: "Tokens used", value: formatTokens(report.tokensUsed), color: "gray" as const });
  }

  if (report.tokensSaved) {
    stats.push({ label: "Tokens saved", value: formatTokens(report.tokensSaved), color: "green" as const });
  }

  if (report.gitBranch) {
    stats.push({ label: "Branch", value: report.gitBranch, color: "yellow" as const });
  }

  if (report.gitCommit) {
    stats.push({ label: "Commit", value: report.gitCommit.slice(0, 7), color: "magenta" as const });
  }

  return (
    <Stack>
      {stats.map((stat, i) => (
        <Inline key={i} gap={0}>
          <MutedText>{stat.label.padEnd(15)}</MutedText>
          <Text color={stat.color}>{stat.value}</Text>
        </Inline>
      ))}
    </Stack>
  );
}

// ============================================
// Utility Functions
// ============================================

function formatReportAsText(report: CompletionReportData): string {
  const lines: string[] = [];

  lines.push(`=== ${report.status.toUpperCase()} ===`);
  lines.push("");
  lines.push(`Summary: ${report.summary}`);
  lines.push("");

  if (report.filesCreated.length > 0) {
    lines.push(`Files Created (${report.filesCreated.length}):`);
    for (const file of report.filesCreated) {
      lines.push(`  - ${file}`);
    }
    lines.push("");
  }

  if (report.filesModified.length > 0) {
    lines.push(`Files Modified (${report.filesModified.length}):`);
    for (const file of report.filesModified) {
      lines.push(`  - ${file}`);
    }
    lines.push("");
  }

  if (report.steps.length > 0) {
    lines.push("Steps:");
    for (const step of report.steps) {
      const icon = step.status === "completed" ? "[x]" : step.status === "failed" ? "[!]" : "[ ]";
      lines.push(`  ${step.index}. ${icon} ${step.description}`);
    }
    lines.push("");
  }

  lines.push(`Tools: ${report.toolsUsed}`);
  lines.push(`Duration: ${report.duration}`);
  lines.push(`Confidence: ${report.confidence}%`);

  return lines.join("\n");
}

// ============================================
// Simple Report Display
// ============================================

export function SimpleCompletionReport({ report }: { report: CompletionReportData }) {
  return (
    <Stack paddingX={1}>
      <StatusBanner status={report.status} />

      <Section title="Summary">
        <AppText wrap="wrap">{report.summary}</AppText>
      </Section>

      <Inline gap={0}>
        <MutedText>Tools: </MutedText>
        <Text color="cyan">{report.toolsUsed}</Text>
        <MutedText> | Duration: </MutedText>
        <WarningText>{report.duration}</WarningText>
        <MutedText> | Confidence: </MutedText>
        <Text color={report.confidence >= 80 ? "green" : "yellow"}>{report.confidence}%</Text>
      </Inline>
    </Stack>
  );
}

// ============================================
// Exports
// ============================================

export default CompletionReport;
