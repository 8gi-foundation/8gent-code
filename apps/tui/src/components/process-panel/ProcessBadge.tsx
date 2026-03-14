import React from "react";
import type { TaskStatus } from "../../../../../packages/tools/background.js";
import { Badge } from "../primitives/index.js";

interface ProcessBadgeProps {
  counts: Record<TaskStatus, number>;
}

export function ProcessBadge({ counts }: ProcessBadgeProps) {
  if (counts.running === 0) return null;

  return (
    <Badge
      label={`${counts.running} process${counts.running > 1 ? "es" : ""}`}
      color="green"
    />
  );
}
