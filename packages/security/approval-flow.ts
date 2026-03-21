/**
 * Approval Flow - session-scoped action approval system.
 *
 * When an action is blocked but approvable, it queues for user approval.
 * Approved actions are session-scoped and don't persist to baseline policy.
 */

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

export interface ApprovalRequest {
  id: string;
  action: string;
  target: string;
  reason: string;
  timestamp: number;
  status: 'pending' | 'approved' | 'denied';
}

export interface ApprovalDecision {
  id: string;
  decision: 'approved' | 'denied';
  actor: string;
  timestamp: number;
}

export class ApprovalFlow extends EventEmitter {
  private pending = new Map<string, ApprovalRequest>();
  private sessionApprovals = new Map<string, Set<string>>();
  private decisions: ApprovalDecision[] = [];

  /**
   * Request approval for a blocked action.
   * Returns the approval ID for tracking.
   */
  requestApproval(action: string, target: string, reason: string): string {
    const id = randomUUID();
    const request: ApprovalRequest = {
      id,
      action,
      target,
      reason,
      timestamp: Date.now(),
      status: 'pending',
    };

    this.pending.set(id, request);
    this.emit('approval:required', request);
    return id;
  }

  /**
   * Approve a pending request. Session-scoped - allows future identical actions.
   */
  approve(approvalId: string, actor = 'user'): boolean {
    const request = this.pending.get(approvalId);
    if (!request || request.status !== 'pending') return false;

    request.status = 'approved';
    this.pending.delete(approvalId);

    // Cache approval for this session
    const key = `${request.action}:${request.target}`;
    if (!this.sessionApprovals.has(request.action)) {
      this.sessionApprovals.set(request.action, new Set());
    }
    this.sessionApprovals.get(request.action)!.add(request.target);

    const decision: ApprovalDecision = {
      id: approvalId,
      decision: 'approved',
      actor,
      timestamp: Date.now(),
    };
    this.decisions.push(decision);

    this.emit('approval:approved', { request, decision });
    return true;
  }

  /**
   * Deny a pending request.
   */
  deny(approvalId: string, actor = 'user'): boolean {
    const request = this.pending.get(approvalId);
    if (!request || request.status !== 'pending') return false;

    request.status = 'denied';
    this.pending.delete(approvalId);

    const decision: ApprovalDecision = {
      id: approvalId,
      decision: 'denied',
      actor,
      timestamp: Date.now(),
    };
    this.decisions.push(decision);

    this.emit('approval:denied', { request, decision });
    return true;
  }

  /**
   * Check if an action+target was previously approved this session.
   */
  isSessionApproved(action: string, target: string): boolean {
    const approvedTargets = this.sessionApprovals.get(action);
    if (!approvedTargets) return false;
    return approvedTargets.has(target);
  }

  getPending(): ApprovalRequest[] {
    return Array.from(this.pending.values());
  }

  getDecisions(): readonly ApprovalDecision[] {
    return this.decisions;
  }

  /**
   * Clear all session approvals (e.g., on session end).
   */
  clearSession(): void {
    this.pending.clear();
    this.sessionApprovals.clear();
    this.decisions = [];
  }
}
