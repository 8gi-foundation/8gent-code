import { createHash } from "crypto";

/**
 * Merkle tree for efficient data integrity verification.
 * Builds a binary tree of hashes from data blocks, supports
 * proof generation and verification, root hash retrieval,
 * and changed block detection between tree states.
 */

export interface MerkleProof {
  blockIndex: number;
  blockHash: string;
  siblings: Array<{ hash: string; position: "left" | "right" }>;
  root: string;
}

export interface MerkleVerifyResult {
  valid: boolean;
  computedRoot: string;
  expectedRoot: string;
}

function sha256(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

function hashPair(left: string, right: string): string {
  return sha256(left + right);
}

export class MerkleTree {
  private leaves: string[];
  private layers: string[][];

  constructor(blocks: string[]) {
    if (blocks.length === 0) {
      throw new Error("MerkleTree requires at least one block");
    }
    this.leaves = blocks.map((b) => sha256(b));
    this.layers = this.buildLayers(this.leaves);
  }

  private buildLayers(leaves: string[]): string[][] {
    const layers: string[][] = [leaves];
    let current = leaves;

    while (current.length > 1) {
      const next: string[] = [];
      for (let i = 0; i < current.length; i += 2) {
        const left = current[i];
        const right = i + 1 < current.length ? current[i + 1] : left;
        next.push(hashPair(left, right));
      }
      layers.push(next);
      current = next;
    }

    return layers;
  }

  /** Returns the Merkle root hash. */
  getRoot(): string {
    const top = this.layers[this.layers.length - 1];
    return top[0];
  }

  /** Returns the total number of leaf blocks. */
  get blockCount(): number {
    return this.leaves.length;
  }

  /**
   * Generates an inclusion proof for the block at the given index.
   * Proof contains sibling hashes at each layer needed to recompute root.
   */
  generateProof(blockIndex: number): MerkleProof {
    if (blockIndex < 0 || blockIndex >= this.leaves.length) {
      throw new RangeError(`Block index ${blockIndex} out of range`);
    }

    const siblings: MerkleProof["siblings"] = [];
    let idx = blockIndex;

    for (let layer = 0; layer < this.layers.length - 1; layer++) {
      const nodes = this.layers[layer];
      const isRight = idx % 2 === 1;
      const siblingIdx = isRight ? idx - 1 : idx + 1;

      if (siblingIdx < nodes.length) {
        siblings.push({
          hash: nodes[siblingIdx],
          position: isRight ? "left" : "right",
        });
      } else {
        siblings.push({ hash: nodes[idx], position: "right" });
      }

      idx = Math.floor(idx / 2);
    }

    return {
      blockIndex,
      blockHash: this.leaves[blockIndex],
      siblings,
      root: this.getRoot(),
    };
  }

  /**
   * Verifies a Merkle proof against the stored root.
   * Returns valid=true only if the proof reconstructs the expected root.
   */
  verifyProof(proof: MerkleProof): MerkleVerifyResult {
    let hash = proof.blockHash;

    for (const sibling of proof.siblings) {
      if (sibling.position === "left") {
        hash = hashPair(sibling.hash, hash);
      } else {
        hash = hashPair(hash, sibling.hash);
      }
    }

    return {
      valid: hash === proof.root,
      computedRoot: hash,
      expectedRoot: proof.root,
    };
  }

  /**
   * Compares this tree against another and returns the indices of blocks
   * whose leaf hashes differ. Useful for detecting changed blocks.
   */
  diffBlocks(other: MerkleTree): number[] {
    const changed: number[] = [];
    const len = Math.max(this.leaves.length, other.leaves.length);

    for (let i = 0; i < len; i++) {
      const a = this.leaves[i];
      const b = other.leaves[i];
      if (a !== b) changed.push(i);
    }

    return changed;
  }

  /** Returns all leaf hashes. */
  getLeafHashes(): string[] {
    return [...this.leaves];
  }
}
