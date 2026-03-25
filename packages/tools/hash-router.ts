/**
 * HashRing - consistent hash ring for distributing load across nodes.
 *
 * Uses virtual nodes (vnodes) for even distribution and weighted routing.
 * Minimises rebalancing when nodes are added or removed.
 */

export interface NodeStats {
  id: string;
  weight: number;
  vnodes: number;
}

export interface RebalanceStats {
  before: NodeStats[];
  after: NodeStats[];
  addedVnodes: number;
  removedVnodes: number;
}

const DEFAULT_VNODES = 150;

function fnv1a32(key: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash;
}

function hashPoint(key: string): number {
  return fnv1a32(key) >>> 0;
}

interface VNode {
  point: number;
  nodeId: string;
}

export class HashRing {
  private ring: VNode[] = [];
  private nodes: Map<string, { weight: number; vnodes: number }> = new Map();
  private sorted = false;

  addNode(id: string, weight = 1): RebalanceStats {
    const before = this.snapshot();

    if (this.nodes.has(id)) {
      this.removeNodeInternal(id);
    }

    const vnodeCount = Math.max(1, Math.round(DEFAULT_VNODES * weight));
    this.nodes.set(id, { weight, vnodes: vnodeCount });

    let added = 0;
    for (let i = 0; i < vnodeCount; i++) {
      const point = hashPoint(`${id}#${i}`);
      this.ring.push({ point, nodeId: id });
      added++;
    }

    this.sorted = false;
    this.ensureSorted();

    const after = this.snapshot();
    return { before, after, addedVnodes: added, removedVnodes: 0 };
  }

  removeNode(id: string): RebalanceStats {
    const before = this.snapshot();
    const removed = this.removeNodeInternal(id);
    const after = this.snapshot();
    return { before, after, addedVnodes: 0, removedVnodes: removed };
  }

  private removeNodeInternal(id: string): number {
    const meta = this.nodes.get(id);
    if (!meta) return 0;

    const before = this.ring.length;
    this.ring = this.ring.filter((v) => v.nodeId !== id);
    this.nodes.delete(id);
    this.sorted = false;
    this.ensureSorted();

    return before - this.ring.length;
  }

  route(key: string): string | null {
    if (this.ring.length === 0) return null;
    this.ensureSorted();

    const point = hashPoint(key);
    const idx = this.findIndex(point);
    return this.ring[idx].nodeId;
  }

  getN(key: string, n: number): string[] {
    if (this.ring.length === 0) return [];
    this.ensureSorted();

    const point = hashPoint(key);
    const start = this.findIndex(point);
    const seen = new Set<string>();
    const result: string[] = [];
    const limit = Math.min(n, this.nodes.size);

    for (let i = 0; i < this.ring.length && result.length < limit; i++) {
      const vnode = this.ring[(start + i) % this.ring.length];
      if (!seen.has(vnode.nodeId)) {
        seen.add(vnode.nodeId);
        result.push(vnode.nodeId);
      }
    }

    return result;
  }

  nodeCount(): number {
    return this.nodes.size;
  }

  stats(): NodeStats[] {
    return this.snapshot();
  }

  private snapshot(): NodeStats[] {
    return Array.from(this.nodes.entries()).map(([id, meta]) => ({
      id,
      weight: meta.weight,
      vnodes: meta.vnodes,
    }));
  }

  private ensureSorted(): void {
    if (!this.sorted) {
      this.ring.sort((a, b) => a.point - b.point);
      this.sorted = true;
    }
  }

  private findIndex(point: number): number {
    let lo = 0;
    let hi = this.ring.length - 1;

    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (this.ring[mid].point < point) {
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }

    return lo % this.ring.length;
  }
}
