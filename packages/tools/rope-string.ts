/**
 * Rope data structure for efficient large text editing.
 * O(log n) insert, delete, substring, and charAt operations.
 */

const LEAF_MAX = 64;

type RopeNode =
  | { kind: "leaf"; value: string; len: number }
  | { kind: "branch"; left: RopeNode; right: RopeNode; len: number };

function leaf(value: string): RopeNode {
  return { kind: "leaf", value, len: value.length };
}

function branch(left: RopeNode, right: RopeNode): RopeNode {
  return { kind: "branch", left, right, len: left.len + right.len };
}

function collectLeaves(node: RopeNode, out: string[]): void {
  if (node.kind === "leaf") {
    out.push(node.value);
  } else {
    collectLeaves(node.left, out);
    collectLeaves(node.right, out);
  }
}

function buildBalanced(leaves: string[]): RopeNode {
  if (leaves.length === 0) return leaf("");
  if (leaves.length === 1) return leaf(leaves[0]);
  const mid = Math.floor(leaves.length / 2);
  return branch(buildBalanced(leaves.slice(0, mid)), buildBalanced(leaves.slice(mid)));
}

function nodeRebalance(node: RopeNode): RopeNode {
  const parts: string[] = [];
  collectLeaves(node, parts);
  const chunks: string[] = [];
  let buf = "";
  for (const p of parts) {
    buf += p;
    while (buf.length >= LEAF_MAX) {
      chunks.push(buf.slice(0, LEAF_MAX));
      buf = buf.slice(LEAF_MAX);
    }
  }
  if (buf.length > 0) chunks.push(buf);
  return buildBalanced(chunks);
}

function nodeCharAt(node: RopeNode, idx: number): string {
  if (node.kind === "leaf") return node.value[idx] ?? "";
  if (idx < node.left.len) return nodeCharAt(node.left, idx);
  return nodeCharAt(node.right, idx - node.left.len);
}

function nodeSubstring(node: RopeNode, start: number, end: number): string {
  if (start >= end) return "";
  if (node.kind === "leaf") return node.value.slice(start, end);
  const leftLen = node.left.len;
  if (end <= leftLen) return nodeSubstring(node.left, start, end);
  if (start >= leftLen) return nodeSubstring(node.right, start - leftLen, end - leftLen);
  return (
    nodeSubstring(node.left, start, leftLen) +
    nodeSubstring(node.right, 0, end - leftLen)
  );
}

function nodeSplit(node: RopeNode, idx: number): [RopeNode, RopeNode] {
  if (node.kind === "leaf") {
    return [leaf(node.value.slice(0, idx)), leaf(node.value.slice(idx))];
  }
  const leftLen = node.left.len;
  if (idx <= leftLen) {
    const [ll, lr] = nodeSplit(node.left, idx);
    return [ll, branch(lr, node.right)];
  }
  const [rl, rr] = nodeSplit(node.right, idx - leftLen);
  return [branch(node.left, rl), rr];
}

function nodeInsert(node: RopeNode, idx: number, text: string): RopeNode {
  const [left, right] = nodeSplit(node, idx);
  return branch(branch(left, leaf(text)), right);
}

function nodeDelete(node: RopeNode, start: number, end: number): RopeNode {
  const [left] = nodeSplit(node, start);
  const [, right] = nodeSplit(node, end);
  return branch(left, right);
}

export class Rope {
  private root: RopeNode;

  constructor(text = "") {
    this.root = text.length === 0 ? leaf("") : nodeRebalance(leaf(text));
  }

  get length(): number {
    return this.root.len;
  }

  charAt(idx: number): string {
    return nodeCharAt(this.root, idx);
  }

  substring(start: number, end = this.root.len): string {
    return nodeSubstring(this.root, Math.max(0, start), Math.min(end, this.root.len));
  }

  insert(idx: number, text: string): Rope {
    const r = new Rope();
    r.root = nodeInsert(this.root, Math.min(idx, this.root.len), text);
    return r;
  }

  delete(start: number, end: number): Rope {
    const r = new Rope();
    r.root = nodeDelete(this.root, Math.max(0, start), Math.min(end, this.root.len));
    return r;
  }

  concat(other: Rope): Rope {
    const r = new Rope();
    r.root = branch(this.root, other.root);
    return r;
  }

  rebalance(): Rope {
    const r = new Rope();
    r.root = nodeRebalance(this.root);
    return r;
  }

  toString(): string {
    const parts: string[] = [];
    collectLeaves(this.root, parts);
    return parts.join("");
  }
}
