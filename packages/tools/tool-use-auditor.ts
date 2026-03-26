/**
 * Define a policy for tool usage.
 * @param blockedTools - Tools blocked from use.
 * @param requireApproval - Tools requiring approval.
 * @param maxCallsPerTool - Maximum allowed calls per tool.
 * @returns The policy object.
 */
export interface Policy {
  blockedTools: Set<string>;
  requireApproval: Set<string>;
  maxCallsPerTool: Map<string, number>;
}

/**
 * Define a policy for tool usage.
 * @param blockedTools - Tools blocked from use.
 * @param requireApproval - Tools requiring approval.
 * @param maxCallsPerTool - Maximum allowed calls per tool.
 * @returns The policy object.
 */
export function definePolicy({
  blockedTools = [],
  requireApproval = [],
  maxCallsPerTool = {},
}: {
  blockedTools?: string[];
  requireApproval?: string[];
  maxCallsPerTool?: { [tool: string]: number };
}): Policy {
  return {
    blockedTools: new Set(blockedTools),
    requireApproval: new Set(requireApproval),
    maxCallsPerTool: new Map(Object.entries(maxCallsPerTool)),
  };
}

/**
 * Audit a single tool call against a policy.
 * @param policy - The policy to check against.
 * @param toolCall - The tool call to audit.
 * @returns Audit result.
 */
export function auditCall(policy: Policy, toolCall: { toolName: string }): {
  allowed: boolean;
  reason: string;
  requiresApproval: boolean;
} {
  const { blockedTools, requireApproval } = policy;
  const isBlocked = blockedTools.has(toolCall.toolName);
  const needsApproval = requireApproval.has(toolCall.toolName);
  return {
    allowed: !isBlocked,
    reason: isBlocked ? 'blocked' : '',
    requiresApproval: needsApproval,
  };
}

/**
 * Audit a session of tool calls against a policy.
 * @param policy - The policy to check against.
 * @param calls - Array of tool calls to audit.
 * @returns Session audit result.
 */
export function auditSession(
  policy: Policy,
  calls: { toolName: string }[]
): {
  allowed: boolean;
  violations: Array<{ tool: string; reason: string }>;
  requiresApproval: boolean;
} {
  const { blockedTools, maxCallsPerTool } = policy;
  const toolCounts = new Map<string, number>();
  const violations: Array<{ tool: string; reason: string }> = [];
  let requiresApproval = false;

  for (const call of calls) {
    const { allowed, reason, requiresApproval: ra } = auditCall(policy, call);
    if (!allowed) {
      violations.push({ tool: call.toolName, reason });
    }
    requiresApproval ||= ra;
  }

  for (const call of calls) {
    toolCounts.set(call.toolName, (toolCounts.get(call.toolName) || 0) + 1);
  }

  for (const [tool, count] of toolCounts.entries()) {
    const limit = maxCallsPerTool.get(tool);
    if (limit !== undefined && count > limit) {
      violations.push({ tool, reason: `exceeded max calls (${count} > ${limit})` });
    }
  }

  const allowed = violations.length === 0;
  return { allowed, violations, requiresApproval };
}

/**
 * Generate a markdown report from an audit result.
 * @param audit - Audit result to render.
 * @returns Markdown report.
 */
export function renderReport(audit: {
  allowed: boolean;
  violations: Array<{ tool: string; reason: string }>;
  requiresApproval: boolean;
}): string {
  let md = '# Tool Usage Audit Report\n\n';
  md += `**Allowed**: ${audit.allowed ? 'Yes' : 'No'}\n`;
  md += `**Requires Approval**: ${audit.requiresApproval ? 'Yes' : 'No'}\n\n`;
  if (audit.violations.length > 0) {
    md += '## Violations\n';
    for (const { tool, reason } of audit.violations) {
      md += `- **${tool}**: ${reason}\n`;
    }
  } else {
    md += '## No Violations Found\n';
  }
  return md;
}