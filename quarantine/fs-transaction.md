# fs-transaction

**Tool name:** FSTransaction
**Package:** `packages/tools/fs-transaction.ts`
**Status:** quarantine

## Description

Atomic filesystem transactions with rollback on failure. Queues write, delete, and rename operations, then commits them atomically using temp-file-then-rename semantics. If any operation fails, all applied operations are reversed in order. A journal at `.8gent/fs-tx-journal.json` tracks pending, committed, and rolled-back transactions for crash recovery inspection.

## API

```ts
const tx = new FSTransaction();
tx.write("output.json", JSON.stringify(data));
tx.delete("old-output.json");
tx.rename("draft.md", "final.md");
await tx.commit(); // throws + rolls back on any failure
```

## Integration path

- Wire into `packages/eight/tools.ts` as registered tools: `fs_transaction_write`, `fs_transaction_commit`
- Use in `packages/validation/` healing loop to apply verified patches atomically
- Use in `packages/self-autonomy/meta-mutation.ts` when mutating config files - safe rollback prevents corrupt state
- Journal file can be consumed by a future recovery agent on startup to detect interrupted transactions
