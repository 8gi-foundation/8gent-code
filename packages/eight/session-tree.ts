/**
 * Session Branching - Tree-structured sessions with fork/navigate
 * Implements a DAG over the flat JSONL session format.
 * Each message has an id + parentId. Branches are derived by walking the tree.
 * @see docs/SESSION-BRANCHING-SPEC.md
 */

export interface SessionNode {
  id: string;
  parentId: string | null;
  branchId: string;
  role: string;
  content: string | unknown[];
  timestamp: number;
}

export interface BranchInfo {
  id: string;
  parentBranchId: string | null;
  forkPointId: string;
  label: string;
  messageCount: number;
  createdAt: number;
}

let counter = 0;
const makeId = () => `n${Date.now().toString(36)}-${(counter++).toString(36)}`;

export class SessionTree {
  private nodes = new Map<string, SessionNode>();
  private children = new Map<string, string[]>();
  private branches = new Map<string, BranchInfo>();
  private _activeBranch = "main";
  private _tipId: string | null = null;

  constructor() {
    this.branches.set("main", {
      id: "main", parentBranchId: null, forkPointId: "",
      label: "main", messageCount: 0, createdAt: Date.now(),
    });
  }

  get activeBranch(): string { return this._activeBranch; }
  get tipId(): string | null { return this._tipId; }

  /** Add a message as child of parentId (null for root). Returns node id. */
  addMessage(parentId: string | null, role: string, content: string | unknown[]): string {
    const id = makeId();
    const node: SessionNode = { id, parentId, branchId: this._activeBranch, role, content, timestamp: Date.now() };
    this.nodes.set(id, node);
    const key = parentId ?? "__root__";
    const kids = this.children.get(key) || [];
    kids.push(id);
    this.children.set(key, kids);
    this._tipId = id;
    const branch = this.branches.get(this._activeBranch);
    if (branch) branch.messageCount++;
    return id;
  }

  /** Fork a new branch at the given node. Returns the new branchId. */
  fork(nodeId: string, label?: string): string {
    const node = this.nodes.get(nodeId);
    if (!node) throw new Error(`Node ${nodeId} not found`);
    const branchId = `fork-${this.branches.size}`;
    this.branches.set(branchId, {
      id: branchId, parentBranchId: node.branchId, forkPointId: nodeId,
      label: label || branchId, messageCount: 0, createdAt: Date.now(),
    });
    this._activeBranch = branchId;
    this._tipId = nodeId;
    return branchId;
  }

  /** Walk from nodeId up through parents to get full history path. */
  getHistory(nodeId: string): SessionNode[] {
    const path: SessionNode[] = [];
    let current: string | null = nodeId;
    while (current) {
      const node = this.nodes.get(current);
      if (!node) break;
      path.unshift(node);
      current = node.parentId;
    }
    return path;
  }

  /** Return all branch info entries. */
  getBranches(): BranchInfo[] {
    return Array.from(this.branches.values());
  }

  /** Switch to a branch and return its message history. */
  switchBranch(branchId: string): SessionNode[] {
    const branch = this.branches.get(branchId);
    if (!branch) throw new Error(`Branch ${branchId} not found`);
    this._activeBranch = branchId;
    let tip: string | null = null;
    for (const [, node] of this.nodes) {
      if (node.branchId === branchId) tip = node.id;
    }
    if (!tip && branch.forkPointId) tip = branch.forkPointId;
    this._tipId = tip;
    return tip ? this.getHistory(tip) : [];
  }

  /** Serialize the full tree as JSONL. */
  toJSONL(): string {
    const lines: string[] = [];
    for (const node of this.nodes.values()) lines.push(JSON.stringify(node));
    return lines.join("\n");
  }

  /** Deserialize a JSONL string into a SessionTree. */
  static fromJSONL(data: string): SessionTree {
    const tree = new SessionTree();
    for (const line of data.split("\n").filter((l) => l.trim())) {
      const obj = JSON.parse(line) as SessionNode;
      tree.nodes.set(obj.id, obj);
      const key = obj.parentId ?? "__root__";
      const kids = tree.children.get(key) || [];
      kids.push(obj.id);
      tree.children.set(key, kids);
      if (!tree.branches.has(obj.branchId) && obj.branchId !== "main") {
        tree.branches.set(obj.branchId, {
          id: obj.branchId, parentBranchId: null, forkPointId: obj.parentId || "",
          label: obj.branchId, messageCount: 0, createdAt: obj.timestamp,
        });
      }
      const branch = tree.branches.get(obj.branchId);
      if (branch) branch.messageCount++;
      tree._tipId = obj.id;
    }
    return tree;
  }
}
