/**
 * 8gent CLUI -- Evidence Panel Component
 *
 * Adapted from apps/tui/src/components/evidence-panel.tsx for React DOM.
 * Collapsible sidebar showing evidence collected during agent execution.
 *
 * Features:
 * - Evidence badges with pass/fail indicators
 * - Grouped by evidence type with summary counts
 * - Confidence meter progress bar
 * - Expandable detail view per item
 * - Framer Motion animations for enter/exit and expand/collapse
 *
 * Color rules: uses only CSS custom properties from tokens.css
 */

import React, { useState, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";

// ── Types ─────────────────────────────────────────────────────────────

export type EvidenceType =
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

export interface Evidence {
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

export interface EvidencePanelProps {
  evidence: Evidence[];
  confidence?: number;
  isOpen: boolean;
  onToggle: () => void;
}

// ── Color Map ─────────────────────────────────────────────────────────

const TYPE_COLORS: Record<EvidenceType, string> = {
  file_exists: "text-accent",
  file_content: "text-info",
  command_output: "text-warning",
  screenshot: "text-brand",
  diff: "text-success",
  test_result: "text-success",
  git_commit: "text-accent",
  git_status: "text-accent",
  directory_listing: "text-info",
  json_content: "text-warning",
  error_log: "text-danger",
};

// ── Evidence Panel ────────────────────────────────────────────────────

export function EvidencePanel({
  evidence,
  confidence,
  isOpen,
  onToggle,
}: EvidencePanelProps) {
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);

  const stats = useMemo(() => {
    const verified = evidence.filter((e) => e.verified).length;
    const failed = evidence.filter((e) => !e.verified).length;
    return { total: evidence.length, verified, failed };
  }, [evidence]);

  const groupedCounts = useMemo(() => {
    const groups: Record<string, { total: number; verified: number }> = {};
    for (const ev of evidence) {
      if (!groups[ev.type]) groups[ev.type] = { total: 0, verified: 0 };
      groups[ev.type].total++;
      if (ev.verified) groups[ev.type].verified++;
    }
    return groups;
  }, [evidence]);

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ width: 0, opacity: 0 }}
          animate={{ width: 320, opacity: 1 }}
          exit={{ width: 0, opacity: 0 }}
          transition={{ duration: 0.2, ease: "easeInOut" }}
          className="
            flex flex-col
            border-l border-subtle
            bg-surface-secondary
            overflow-hidden
            h-full
          "
        >
          {/* Header */}
          <div className="flex items-center justify-between px-3 py-2 border-b border-subtle">
            <div className="flex items-center gap-2">
              <span className="text-accent font-bold text-xs">Evidence</span>
              <span className="text-muted text-xs">
                <span className="text-success">{stats.verified}</span>
                /{stats.total} verified
              </span>
            </div>
            <button
              onClick={onToggle}
              className="text-muted hover:text-accent text-xs transition-colors duration-150"
              aria-label="Close evidence panel"
            >
              &times;
            </button>
          </div>

          {/* Confidence meter */}
          {confidence !== undefined && (
            <div className="px-3 py-2 border-b border-subtle">
              <ConfidenceMeter confidence={confidence} />
            </div>
          )}

          {/* Evidence list */}
          <div className="flex-1 overflow-y-auto px-2 py-1">
            {evidence.length === 0 ? (
              <div className="text-muted text-xs italic py-4 text-center">
                No evidence collected yet.
              </div>
            ) : (
              evidence.map((ev, index) => (
                <EvidenceItem
                  key={`${ev.type}-${index}`}
                  evidence={ev}
                  isExpanded={index === expandedIndex}
                  onToggle={() =>
                    setExpandedIndex(expandedIndex === index ? null : index)
                  }
                />
              ))
            )}
          </div>

          {/* Footer: grouped summary */}
          {Object.keys(groupedCounts).length > 0 && (
            <div className="px-3 py-2 border-t border-subtle flex flex-wrap gap-2">
              {Object.entries(groupedCounts).map(([type, counts]) => (
                <span key={type} className="text-xs">
                  <span className="text-muted">{type.replace("_", " ")}: </span>
                  <span
                    className={
                      counts.verified === counts.total
                        ? "text-success"
                        : "text-warning"
                    }
                  >
                    {counts.verified}/{counts.total}
                  </span>
                </span>
              ))}
            </div>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// ── Evidence Item ─────────────────────────────────────────────────────

interface EvidenceItemProps {
  evidence: Evidence;
  isExpanded: boolean;
  onToggle: () => void;
}

function EvidenceItem({ evidence, isExpanded, onToggle }: EvidenceItemProps) {
  const icon = evidence.verified ? "\u2713" : "\u2717";
  const iconClass = evidence.verified ? "text-success" : "text-danger";
  const typeClass = TYPE_COLORS[evidence.type] || "text-muted";

  return (
    <div className="border-b border-subtle/50 last:border-b-0">
      <button
        onClick={onToggle}
        className="
          w-full flex items-start gap-1.5 px-2 py-1.5
          hover:bg-surface-elevated/50
          transition-colors duration-100
          text-left
        "
      >
        <span className={`${iconClass} text-xs flex-shrink-0 mt-0.5`}>{icon}</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span
              className={`
                text-[10px] px-1 py-0 rounded border border-current/20
                ${typeClass}
              `}
            >
              {evidence.type.replace("_", " ")}
            </span>
          </div>
          <div className="text-xs text-text-primary truncate mt-0.5">
            {evidence.description}
          </div>
        </div>
        <span
          className="text-muted text-xs flex-shrink-0 mt-0.5 transition-transform duration-150"
          style={{ transform: isExpanded ? "rotate(90deg)" : "rotate(0deg)" }}
        >
          &rsaquo;
        </span>
      </button>

      {/* Expandable detail */}
      <AnimatePresence>
        {isExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="overflow-hidden"
          >
            <div className="px-3 pb-2 ml-4 border-l-2 border-info/30 text-xs space-y-0.5">
              {evidence.path && (
                <div>
                  <span className="text-muted">Path: </span>
                  <span className="text-accent">{evidence.path}</span>
                </div>
              )}
              {evidence.command && (
                <div>
                  <span className="text-muted">Command: </span>
                  <span className="text-accent">{evidence.command}</span>
                </div>
              )}
              {evidence.exitCode !== undefined && (
                <div>
                  <span className="text-muted">Exit code: </span>
                  <span
                    className={
                      evidence.exitCode === 0 ? "text-success" : "text-danger"
                    }
                  >
                    {evidence.exitCode}
                  </span>
                </div>
              )}
              {evidence.duration !== undefined && (
                <div>
                  <span className="text-muted">Duration: </span>
                  <span className="text-text-secondary">{evidence.duration}ms</span>
                </div>
              )}
              {evidence.size !== undefined && (
                <div>
                  <span className="text-muted">Size: </span>
                  <span className="text-text-secondary">
                    {formatBytes(evidence.size)}
                  </span>
                </div>
              )}
              {evidence.hash && (
                <div>
                  <span className="text-muted">Hash: </span>
                  <span className="text-muted">{evidence.hash.slice(0, 16)}...</span>
                </div>
              )}

              {/* Data preview */}
              <div className="mt-1">
                <span className="text-muted">Data: </span>
                <DataPreview data={evidence.data} />
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ── Confidence Meter ──────────────────────────────────────────────────

function ConfidenceMeter({ confidence }: { confidence: number }) {
  const pct = Math.max(0, Math.min(100, confidence));
  const colorClass =
    pct >= 80 ? "bg-success" : pct >= 50 ? "bg-warning" : "bg-danger";
  const textClass =
    pct >= 80 ? "text-success" : pct >= 50 ? "text-warning" : "text-danger";

  return (
    <div className="flex items-center gap-2">
      <span className="text-muted text-xs">Confidence:</span>
      <div className="flex-1 h-1.5 rounded-full bg-surface-elevated overflow-hidden">
        <motion.div
          initial={{ width: 0 }}
          animate={{ width: `${pct}%` }}
          transition={{ duration: 0.5, ease: "easeOut" }}
          className={`h-full rounded-full ${colorClass}`}
        />
      </div>
      <span className={`text-xs font-bold ${textClass}`}>{pct}%</span>
    </div>
  );
}

// ── Data Preview ──────────────────────────────────────────────────────

function DataPreview({ data }: { data: string | object | boolean }) {
  if (typeof data === "boolean") {
    return (
      <span className={data ? "text-success" : "text-danger"}>
        {String(data)}
      </span>
    );
  }

  if (typeof data === "string") {
    const preview = data.split("\n")[0].slice(0, 60);
    return <span className="text-muted">&quot;{preview}...&quot;</span>;
  }

  if (typeof data === "object") {
    try {
      const preview = JSON.stringify(data).slice(0, 60);
      return <span className="text-muted">{preview}...</span>;
    } catch {
      return <span className="text-muted">[object]</span>;
    }
  }

  return <span className="text-muted">-</span>;
}

// ── Helpers ───────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default EvidencePanel;
