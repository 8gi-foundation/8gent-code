# merkle-tree

**Tool:** `MerkleTree`
**File:** `packages/tools/merkle-tree.ts`
**Status:** quarantine

## Description

Merkle tree for efficient data integrity verification. Builds a binary hash tree from arbitrary data blocks using SHA-256. Supports root hash retrieval, inclusion proof generation, proof verification, and diffing two trees to identify changed blocks.

## API

| Method | Description |
|--------|-------------|
| `new MerkleTree(blocks: string[])` | Build tree from data blocks |
| `.getRoot(): string` | Get Merkle root hash |
| `.generateProof(index): MerkleProof` | Generate inclusion proof for a block |
| `.verifyProof(proof): MerkleVerifyResult` | Verify a proof against the root |
| `.diffBlocks(other): number[]` | Return indices of blocks that changed vs another tree |
| `.getLeafHashes(): string[]` | Return all leaf hashes |

## Integration Path

1. Wire into `packages/validation/` for checkpoint integrity checks - verify agent state snapshots have not been tampered with.
2. Use in `packages/memory/store.ts` to detect which memory segments changed between consolidation cycles.
3. Expose as an agent tool in `packages/eight/tools.ts` so Eight can verify file sets during sync operations.

## Usage Example

```typescript
import { MerkleTree } from "./packages/tools/merkle-tree.ts";

const tree = new MerkleTree(["block0", "block1", "block2"]);
console.log(tree.getRoot());

const proof = tree.generateProof(1);
const result = tree.verifyProof(proof);
// result.valid === true

const updated = new MerkleTree(["block0", "CHANGED", "block2"]);
console.log(tree.diffBlocks(updated)); // [1]
```
