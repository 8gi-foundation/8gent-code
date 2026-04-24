# Grove Byzantine Defense — Design

> Issue #1567 / parent #1559. Status: **DESIGN DRAFT**, not implemented.

## Threat

A Grove peer accepts inference work, runs the request through a tampered model (poisoned weights, modified tokenizer, swapped sampler), and returns a corrupted answer that looks superficially correct. This is a supply-chain attack at the inference layer.

The attack works because the requester has no independent way to know the answer is wrong. The peer says "the model said X". Unless someone else also ran the same prompt through the same model on a clean shard, X is taken on trust.

This is the most dangerous pre-GA attack vector for Grove. Slashing reputation after the fact does not undo a wrong answer that already shaped a downstream decision (e.g. a generated patch, a generated email, a generated trade). Detection has to happen *before* the requester acts on the result.

## Goal

For any external-peer request, the requester gets a result whose correctness has been **independently corroborated by k peers** out of an n-peer ring. If any peer's output diverges from the rest, that peer is rejected and reputation slashed; the requester gets the consensus answer with a confidence label.

For LOCAL-ONLY mode (the spike) this is not required — peers are trusted LAN.

## Approach: k-of-n redundant execution + logit-hash spot checks

### Two-tier defence

The full k-of-n on every request is expensive (k× inference cost). So defence runs at two tiers:

| Tier | When | Cost | Catches |
|------|------|------|---------|
| **Tier 1: Logit-hash spot check** | Random sample (~5% of requests) | ~2× inference for sampled requests only | Sustained tampering (anyone tampering more than rarely will get caught) |
| **Tier 2: Full k-of-n** | High-stakes requests (signed by requester as "verify") | k× inference | Targeted tampering on a specific high-value request |

Default: Tier 1 only. Tier 2 is an opt-in flag the requester sets per request when the answer matters enough to pay for it.

### Tier 1 — Logit-hash spot check

For each spot-checked request:

1. Requester sends the same prompt to k peers (k=2, the cheapest non-trivial check).
2. Each peer streams logits at every token position. Instead of streaming full logits (huge), each peer hashes the top-K logit values + the chosen token, salt-prefixed by request id, and emits the hash with each token.
3. Requester compares hashes position-by-position. Identical hashes for k peers means: same model, same weights, same sampling state.
4. Divergence on any position → both peers' outputs are quarantined. Reputation is slashed for both until the requester (or a third peer) breaks the tie.

Hash, not raw logits, because:
- Bandwidth: ~16 bytes per token vs ~50KB of raw logits per token
- Privacy: raw logits leak more about model internals than the hash does

Top-K only (e.g., K=20), because lower-tail logits are deterministic noise on most inference paths and cause false positives across hardware (different GPU/CPU/quantization gives different rounding for low-probability tokens).

### Tier 2 — Full k-of-n with consensus

For requests flagged `verify: true`:

1. Requester selects k peers (k=3 minimum for byzantine fault tolerance: tolerates 1 dishonest).
2. Each peer runs the request independently. Logits are hashed as in Tier 1.
3. Requester collects all k results plus their hash streams.
4. **Consensus rule:** Majority among k. With k=3, 2-of-3 must agree on every token. If 3-way disagreement, request is rejected — no consensus, requester must retry with a different peer set.
5. Slashing: peers whose output diverged from majority lose reputation. If 3-way disagreement, all 3 lose minor reputation (signal: pick a more diverse peer set).

## Cost analysis

Assume baseline inference cost = $1 unit, baseline latency = T.

| Mode | Cost | Latency | Attack window |
|------|------|---------|---------------|
| No defence | 1.0 | T | Wide open |
| Tier 1 only (5% sampled, k=2) | 1.05 (avg) | T | Hard to sustain — odds of evading 5% sampling decay exponentially |
| Tier 2 only (k=2) | 2.0 | max(2 peers) ≈ 1.1T | Catches 1 dishonest peer; misses collusion |
| Tier 2 (k=3) | 3.0 | max(3 peers) ≈ 1.2T | Tolerates 1 byzantine peer; needs 2 colluders to corrupt |
| Tier 1 + Tier 2 (mixed) | ~1.05–3.0 depending on flag | depends | Default-cheap with opt-in expensive |

For most user requests Tier 1 is enough. Reserve Tier 2 for moments where the answer drives an irreversible action (a code commit, a financial trade, a public message). The requester decides — they know which questions matter.

## Slashing mechanics

Reputation is a numeric score per peer in the registry. Starts at 1000. Decay rules:

| Event | Penalty |
|-------|---------|
| Tier 1 hash mismatch (peer is in minority of 1) | -50 |
| Tier 2 disagreement with majority (k=3) | -100 |
| Tier 2 unable to reach consensus (all 3 disagree) | -10 each (signal: pick different next time) |
| Sustained mismatch across 5+ consecutive checks | suspended (score → 0, removed from active pool) |
| 30 days clean operation | +10 (slow recovery) |

Suspended peers can rejoin only by re-passing the consent ceremony and a clean-room attestation.

## Reference implementation outline

`packages/grove/inference/byzantine.ts` (NOT yet created):

```ts
type LogitHash = string; // 16-byte hex of sha256(top-K logits || chosen token || requestId)

interface PeerInferenceStream {
  peerId: string;
  tokens: AsyncIterable<{ token: string; hash: LogitHash; position: number }>;
  finalText: Promise<string>;
}

interface ByzantineConfig {
  mode: "tier1-spotcheck" | "tier2-full";
  k: number;                  // 2 for tier1, ≥3 for tier2
  spotCheckRate: number;      // 0..1, applies in tier1 mode only
}

async function byzantineInfer(
  request: TaskPayload,
  peers: PeerInfo[],
  config: ByzantineConfig
): Promise<{
  output: string;
  confidence: "consensus" | "single-source" | "no-consensus";
  divergedPeers: string[];
}> {
  // ...
}
```

Slashing call-out: this function does NOT mutate reputation directly. It returns `divergedPeers`. The mesh layer (registry-aware) is the one that translates `divergedPeers` into score adjustments. Keeps inference layer pure.

## Test harness

`packages/grove/inference/byzantine.test.ts` will spawn 3 mock peers:
- 2 honest (same hash output for the same prompt)
- 1 Byzantine (returns different hash for at least one token position)

Run 100 requests in Tier 2 mode. Assert:
1. Output is always the majority answer (the honest answer)
2. Byzantine peer is in `divergedPeers` for ≥99% of the runs
3. The 1% slack accounts for the case where the Byzantine peer happens to corrupt a token position that doesn't change the final text — acceptable since the corruption was localized and didn't surface in output

## Feature flag

`--grove-byzantine-defense=tier1` (default for any `--grove-external` mode)
`--grove-byzantine-defense=tier2` (per-request opt-in via API field `verify: true`)
`--grove-byzantine-defense=off` (LOCAL-ONLY only — refuses to start with `--grove-external`)

## Out of scope for v0

- **Cross-model consensus.** k=3 with three different models may disagree because they're different models, not because anyone is byzantine. Solving this is an open problem (semantic consensus over text). v0 requires k peers to run *the same* model + version + quantization. The registry tracks these tuples and the requester picks a homogeneous peer set.
- **Hardware-attested execution.** TEE / Nitro Enclave / SGX as a stronger primitive. Possible v1 if cost makes economic sense.
- **Side-channel mitigation.** Even k=3 peers running clean weights can leak the prompt through query timing, logit timing, or memory pressure. Out of scope here — that's a hardening pass after this lands.

## Open questions for review

1. **Hash collision risk at K=20.** sha256 is overkill but cheap. Is 16-byte truncated hash safe enough? (Probably yes — collisions need to be engineered, not chance-encountered.)
2. **Clock-drift across peers in registry.** If two peers report a heartbeat 89s apart, are they "live" together? Reuse the existing 90s freshness window (already in `vessel-mesh.ts`).
3. **Slashing visibility.** Should slashed peers be told why? Probably yes — surface the request ID and the position where divergence happened so honest peers can self-debug. Dishonest peers learn nothing they don't already know.
4. **k=2 in Tier 2 vs k=3.** k=2 catches a single liar but two-peer collusion defeats it. k=3 tolerates 1 byzantine. Cost difference is 50% per-request. Default Tier 2 to k=3.

## Decision needed

Before implementing, board needs to confirm:
- Default Tier 1 spot-check rate (proposing 5%)
- Tier 2 default k (proposing 3)
- Slashing curve (proposing -50 / -100 / 30-day +10 recovery)
- Reputation as soft-decay vs hard-suspension at score 0 (proposing both, see slashing table)

## References

- Constitution: Lotus-Class Compute (Article 11)
- Parent: #1559
- Spike: `packages/orchestration/vessel-mesh.ts` (registry, peers map, lastHeartbeat — all reused)
- Related blocker: #1569 zero-log invariant (orthogonal — that's about persistence, this is about inference correctness)
