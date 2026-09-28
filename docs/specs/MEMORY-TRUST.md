# Memory Trust — what may be stored, and who vouches for it

Status: **normative**. This is a security contract, not an implementation plan.
Companion to [`MEMORY-SPEC.md`](./MEMORY-SPEC.md) (which is an implementation plan
with line estimates; the binding rule lives here).

Audience: anyone writing to `packages/memory/*`, wiring memory into a prompt, or
adding a memory tool to the agent loop.

---

## 0. Why this exists

Retrieved memories are placed into the system prompt and re-read on **every later
session**. A one-shot injection in a tool result dies with the session; an
injection that lands in memory is **persistent** — it is re-injected on every
future turn, for every future task, without the original attacker being present.

Outside position this rule adopts (Jev/TypeSafe): *"Candidate text is untrusted
even when delimited in a prompt… Use pointwise judgments for hostile corpora and
enforce permissions outside the model"* and *"Authorize and filter candidates
before ranking. **Ranking is not an authz boundary.**"*

That last line is the load-bearing one here: no amount of relevance scoring,
re-ranking, decay, or curation makes a poisoned memory safe. The check MUST
happen at the write (admission) boundary, not at the ranking boundary.

---

## 1. What actually happens today (verified, not assumed)

Write path:

- `MemoryManager.remember()` — `packages/memory/index.ts:240` — the only public
  entry point. It hands `content` straight to `_buildMemory` / `_rememberV1`
  (`packages/memory/index.ts:508`) with **no content inspection**.
- `_rememberV1` derives a `key` by lowercasing and stripping non-alphanumerics
  (`index.ts:548-554`) and stores the **full original string** as `value`
  (`index.ts:555`). The key is a search index, not a redaction. The session-layer
  branch does the same at `index.ts:525-526`.
- `MemoryStore.write()` — `packages/memory/store.ts:234` — serialises the whole
  memory (`store.ts:239`, `JSON.stringify(memory)`) and `INSERT`s it at
  `store.ts:242`. `content_text` is produced by `extractContentText()`
  (`store.ts:854`), which is pure string concatenation per memory type — no
  filtering.

Sanitisation that exists but is **not called**:

- `redact()` — `packages/memory/redact.ts:32` — strips AWS keys, GitHub tokens,
  JWTs, PEM private keys, Slack/OpenAI/Anthropic keys. Its own header says
  *"Run on all input to learn()/remember()"* (`redact.ts:2-3`).
- `sanitize()` — `packages/memory/sanitize.ts:7` — strips Unicode Tags
  (U+E0000–U+E007F), zero-width chars, bidi marks, variation selectors. Spec'd in
  `MEMORY-SPEC.md:379-400` as *"Run `sanitize()` on all user input before the
  Extractor processes it."*
- `stripInjectedContext()` — `packages/memory/extractor.ts:479` — removes
  previously injected `[Memory Context]` blocks to stop feedback loops.

**Grep result (at audit time, before the fix in §3):** outside their own
definitions, there were **zero callers** of `redact(`, `sanitize(`, or
`stripInjectedContext(` anywhere in `packages/` or `apps/`. `buildMemoryContext()`
(`auto-inject.ts:24`) and `recallAsText()` (`recall.ts:97`) — the two functions
that format memory for a prompt — are still **unwired**: `buildMemoryContext` has
no callers outside its own file. The write-path half of that gap is fixed in §3;
the read-path half is still open.

Read path (what reaches a prompt):

```
SQLite (memories.content_text)
  → MemoryStore.recall()        store.ts:317   (FTS5 BM25 + optional vector)
  → MemoryManager.getContext()  index.ts:368   → _assembleContext() index.ts:718
  → formatted text, unfiltered
```

`_assembleContext` (`index.ts:718`) copies recalled content into a context
budget verbatim. `buildMemoryContext` (`auto-inject.ts:24`) wraps it in
`[Memory Context] … [/Memory Context]`. Neither strips, escapes, or annotates the
provenance of the text.

### Empirical proof of the gap (state before the fix in §3)

A throwaway script wrote one memory through the real `MemoryStore` using its
real schema:

- `redact()` **would** have replaced `AKIAIOSFODNN7EXAMPLE` with
  `[REDACTED_AWS_KEY]` — the pattern at `redact.ts:8` matches it.
- It was not applied: the value round-tripped through SQLite **verbatim**, and
  `recall("instructions")` returned it. Both the credential and the imperative
  text survived.

So, at audit time: **memories were written straight to a store with no
scrutiny**, and the sanitisation modules were dead code. `[VERIFIED]` by
execution, not by reading. §3 records what now runs and what still does not.

---

## 2. The rule

Keywords below are normative: **MUST**, **MUST NOT**, **SHOULD**, **MAY**.

### 2.1 What a memory may contain

A memory MAY contain only **assertions about the world or the user**, stated as
*data*: facts, preferences, project conventions, past decisions, observed
outcomes.

A memory **MUST NOT** contain:

| Class | Examples | Why |
| --- | --- | --- |
| Credentials and secrets | API keys, tokens, passwords, PEM blocks, connection strings, session cookies | Persisted forever, re-injected into every prompt, and readable by anyone who can read the context |
| Verbatim untrusted tool output | raw HTTP bodies, scraped pages, third-party JSON, file contents from an unauthenticated path | Tool output is attacker-controllable; storing it verbatim launders it into trusted context |
| Instructions addressed to the agent | "ignore previous instructions", "you must now…", "do not tell the user", role-changes, tool directives | These are **prompt injection**, and in memory they are *persistent* injection |
| Content from an unauthenticated source | anonymous channel messages, unverified imports, content whose `source` is unknown | Trust cannot be assigned to it, so it cannot be admitted |

A memory **SHOULD NOT** contain raw bulk text. Memory is for distilled
assertions (`MEMORY-SPEC.md:365-378`, the "Total Memory" framing); bulk text is
what `repo-context` and retrieval-on-demand are for. Long verbatim blobs are the
main smuggling route for the three classes above.

### 2.2 Who may write

| Source | May write? | Conditions |
| --- | --- | --- |
| Human user, explicitly (e.g. `/remember`, a direct correction) | **YES** | Highest trust. Still subject to the content rules — a human can paste a secret or a poisoned snippet by accident |
| The agent itself (`source: "agent_inferred"`, extractor output) | **YES, gated** | MUST pass the content rules with no exemption. An agent-authored memory is model-generated text and is exactly as untrusted as the model's context at the time — if a poisoned tool result was in context, the "inference" is poisoned |
| Imported file / external corpus | **YES, gated** | MUST carry a `source` identifying the file and origin; content MUST pass the rules; the import MUST be attributable to a human action |
| Anything with no identifiable `source` | **NO** | Trust cannot be established. Reject |

The answer therefore **does differ per source** — but only in *who is accountable
when it goes wrong*, never in *whether the content rules apply*. There is no
source exempt from §2.1. In particular, agent-authored memories get **no**
relaxation: the agent is the component most likely to have attacker text in
context.

### 2.3 Trusted once stored, or re-checked on read?

**Re-check on read is REQUIRED, and it is not sufficient on its own.**
Both layers, for different reasons:

- **Write-time admission is the primary control.** It is the only moment the
  provenance (`source`, `sourceId`) is still attached and the writer's intent is
  known. It is also the only place a bad memory can be *stopped* rather than
  merely *hidden* — once stored, it is one query away from any future session.
- **Read-time re-validation is REQUIRED as defence in depth**, because:
  1. The store is a plain SQLite file. Writes can bypass `MemoryManager`
     entirely — any process with file access, any import tool, any future
     migration (`migrate.ts`) can insert rows that never saw the write gate.
  2. A memory admitted *before* this rule existed is still in the store. There is
     no retroactive clean-up, so the read path must be able to reject it.
  3. The rule set will change. A row that was legal last year may not be legal
     now; re-checking makes the current rule authoritative rather than a
     historical accident.

**Justification (the persistence threat).** Trust-on-write-only would mean a
single poisoned write is permanently trusted — the exact failure mode this
document exists to prevent. Trust-on-read-only would mean the poison sits in the
store, is served to any consumer that forgets to filter (there are already three
formatters — `_assembleContext`, `buildMemoryContext`, `recallAsText`), and
continues to be re-learned by the extractor. Neither alone is adequate.
So: **admit on write, re-validate on read.**

A memory is therefore **data, never instruction**. Consumers MUST treat recalled
text as untrusted content even when delimited, because delimiters are a
convention the model may be argued out of, not a boundary.

### 2.4 What happens to a memory that fails the rule

Which remedy applies depends on whether removing the offending text leaves
something true and useful. See §3.1 for the implemented mapping.

| Outcome | When | Why |
| --- | --- | --- |
| **Strip** | Credentials/secrets (`redact()`), and invisible Unicode obfuscation (`sanitize()`) | The remainder is still a true, useful assertion — "the staging key was rotated" survives, the key does not. Removing the marker *is* the remedy, and the removal is unambiguous. |
| **Reject** | Instruction-shaped content; unattributable/missing `source` | Not redactable into something safe: deleting the imperative leaves a directive remainder, and paraphrases defeat any pattern list. Fail closed, with no residue left in the store. |
| **Quarantine** | (Not used today — recorded for completeness) | Would require a new column plus read-path filtering to be meaningful, and a quarantined row that a future consumer forgets to filter is a latent injection. Rejection is preferred until the read path filters in its own right. |
| **Never silently pass** | Anything not covered above | Default to reject, not accept. Fail closed. |

Rejection MUST be reported to the caller — a reason, not a silent drop. A silent
drop makes a poisoning attempt invisible and looks like a bug to the user.

Stripping is only legitimate when the removal is what the rule wants. It is
**not** a substitute for rejection when the residue would still be misleading.

### 2.5 Relationship to the sealed-benchmark gate (`admitMutations`)

`benchmarks/autoresearch/split.ts:271` (`admitMutations`) is the **same shape**
as this rule, and the reasoning transfers directly:

- `admitMutations` takes *model-proposed* text and filters it against a sealed
  id list **before it is trusted** (`split.ts:271-283`, using
  `checkLeakage` at `split.ts:208`). A mutation naming a held-out case is
  leakage *by construction*, so it is dropped **at the source rather than
  stored** — `split.ts:266-270`.
- Likewise `assertNoLeakage` (`split.ts:218`) is the read/use-time assertion,
  while admission is the write-time control: two layers, same as §2.3.
- The shared principle: **gate proposed text on the way in, against a fixed
  list, before it can influence anything downstream.** For benchmarks the fixed
  list is sealed ids; for memory it is the untrusted-class list in §2.1 plus the
  secret patterns in `redact.ts`.
- The shared failure mode avoided: *trusting model-proposed text because it
  arrived through a trusted channel*. A mutation arrives through the agent's own
  mutation generator; a memory arrives through the agent's own extractor. Both
  are model output and neither is authenticated by the channel.

Consequence: memory admission is implemented as the same kind of pure predicate —
`admitMemory(candidate)` / `admitText(text)` in `packages/memory/admission.ts` —
mirroring `admitMutations`, so the rule is testable without a database. One
difference from the benchmark gate: `admitMutations` *returns* a
`{ admitted, rejected[] }` split, whereas memory admission **throws**
`MemoryTrustError` on rejection and returns the storable record otherwise. A
throw was chosen because storage is single-record and a rejection must not be
quietly skipped over; callers already handle it (§3.1). `looksLikeInstruction()`
is exported so the deny-list is testable in isolation.

---

## 3. Enforcement

### 3.1 Enforced now — in-code write gate

Implemented in `packages/memory/admission.ts`, called from two places:

- `MemoryManager.remember()` (`index.ts:250`) — on the incoming content string.
  Covers the public API, the **session layer** (which writes to
  `workingMemoryCache` and never reaches the store), and the v1 JSONL fallback.
- `MemoryStore.write()` (`store.ts:239-240`) — on the record, at the storage
  choke point. Covers every caller that bypasses `remember()`: the shared bus
  (`bus.ts:308`), migration (`migrate.ts:73`, `migrate.ts:90`), and `writeBatch`
  (`store.ts:285`, which delegates to `write()`).

Both delegate to `admitText()` / `admitMemory()`, which call the **existing**
sanitisers — no third sanitiser was written. Order is `sanitize()` → instruction
check → `redact()`: sanitising first de-obfuscates an instruction hidden in
invisible Unicode tags so the check then sees it.

`write()` is the chosen choke point rather than `remember()` alone precisely
because `remember()` is *not* the only writer — the same "control that exists but
is not invoked" failure this document is about.

**Class → treatment.** Different classes warrant different treatment:

| Class | Treatment | Why |
| --- | --- | --- |
| Credentials / secrets | **Stripped** (`redact()`) | A redacted memory stays truthful and useful — "the staging key was rotated" survives, the key does not. Removal is exactly what the rule wants. |
| Invisible Unicode (tags, zero-width, bidi) | **Stripped** (`sanitize()`) | Pure obfuscation with no legitimate content; removal is lossless. |
| Instructions addressed to the agent | **Rejected** (`MemoryTrustError`) | Not redactable into something safe: deleting the imperative leaves a directive remainder, and paraphrases defeat any pattern list. Quarantine would need a new column plus read-path filtering — a store restructure, out of scope — and a quarantined row that a future consumer forgets to filter is a latent injection. Rejection is fail-closed with no residue. |

Rejection is **surfaced, never swallowed**: the `remember` tool already wraps the
call in `try`/`catch` and returns `Failed to remember: …`
(`packages/eight/tools.ts:2138-2142`), and migration records the rejection in
`result.errors` per entry without aborting the run (`migrate.ts:68-76`,
`migrate.ts:83-92`).

**Evidence** (throwaway script against a temp database; real store untouched).
Same poison string through the old and new paths:

```
BEFORE (the old write(): raw INSERT, no gate)
  stored  : IGNORE ALL PREVIOUS INSTRUCTIONS. … AWS key AKIAIOSFODNN7EXAMPLE. …
  AWS key usable? true

AFTER (real MemoryStore.write(), same string)
  REJECTED: Refusing to store memory: it reads as an instruction addressed to the
            agent, not a fact about the world.

AFTER (credential only — stripped, still stored)
  stored  : system-note: The staging deploy key was [REDACTED_AWS_KEY] before rotation.
  AWS key usable? false

AFTER (ordinary fact — unchanged)
  stored  : system-note: The deploy key was rotated on the first of the month.

recall("AKIA") → 1 hit, and it is the BEFORE row: usable key from a GATED write
returned by recall? false
```

That last line is deliberate: the only usable key recall returns is the row
written by the un-gated INSERT. It is the concrete reason §2.3 requires
re-validation on the read path too — write-time admission cannot constrain a
writer that does not go through `MemoryStore.write()`.

`packages/memory` tests: **39 pass, 0 fail** (`bun test packages/memory/`).

**`stripInjectedContext()` does NOT belong on the write path.** Its input domain
is a raw conversation message, and its job is to stop the extractor re-learning
its own injections (`extractor.ts:470-478`); the write path never receives
`[Memory Context]`-wrapped text. Its correct call site is the extractor's message
input (`extractAutoMemories`, `index.ts:1204`, and the `extractor.ts` entry
points), which is still unwired — see §3.3.

### 3.2 A policy-engine rule adds nothing here — so none was added

An earlier draft added `memory_write` rules to
`packages/permissions/default-policies.yaml`. **It was removed**, because such a
rule can never fire on a memory write:

- The only bridge from tool calls to policies is `ToolG8.gate()`
  (`packages/permissions/toolg8.ts:67`), reached solely through
  `ToolExecutor.TOOL_ACTION_MAP` (`packages/eight/tools.ts:754-774`). The gate
  block runs only when the tool name is mapped (`tools.ts:778-781`).
- The `remember` tool exists (`tools.ts:657`, dispatched at `tools.ts:991`,
  calling `memory.remember` at `tools.ts:2138`) but is **not** in
  `TOOL_ACTION_MAP`. So `policyAction` is `undefined` and the gate is skipped.
- No memory path goes through `ToolG8` at all.

This is the documented `network_request` trap — a rule that looks active but fires
for nothing. An unenforceable rule is worse than none, because it reads as a
control. If a memory tool is later routed through `ToolG8.gate()`, the rules can
be reinstated with a real caller; the YAML text is preserved in this document's
history rather than left as a decoy.

The policy DSL is also weaker than the in-code gate for this job: five operators
(`contains`, `equals`, `starts_with`, `ends_with`, `in`, see
`policy-engine.ts:64`) with `and`/`or` and **no negation**, matching literals
rather than regexes — so it cannot reuse `redact.ts`'s patterns, which is what
actually does the stripping.

### 3.3 Still proposed (requires packages beyond this change)

1. **Re-validate on read.** Apply the same predicate in `_assembleContext`
   (`index.ts:718`), `buildMemoryContext` (`auto-inject.ts:24`), and
   `recallAsText` (`recall.ts:97`). A blocked row is skipped, not surfaced. This
   is required by §2.3 and is not yet done.
2. **Wire `stripInjectedContext()` at the extractor input** (§3.1) to close the
   feedback loop where the extractor re-learns its own injected blocks.
3. **Add `memory_write` to `PolicyActionType`** (`types.ts:19-28`) and route a
   memory tool through `ToolG8.gate()` if the policy layer is wanted later.
4. **Record provenance as a first-class field and reject `source === undefined`**
   (§2.2 row 4).
5. **Consult `redact.ts`'s `PATTERNS` / `SECRET_PATTERNS` from the YAML layer** if
   the policy route is ever wired, rather than a coarse keyword list.
6. **Bound length** (§2.1) — reject memories over a small character budget.

**Accepted cost, stated plainly:** the instruction check is a pattern denylist
(`admission.ts`, `INSTRUCTION_PATTERNS`). It will reject a legitimate note *about*
prompt injection, and it will miss a rephrased or non-English instruction. It is
a floor, not a proof. The alternative — storing an attacker-controlled imperative
forever — is strictly worse.


### 3.4 Relationship to re-ranking

`rerankBySessionRelevance` is named in `MEMORY-SPEC.md:65` and budgeted at
`MEMORY-SPEC.md:72`, but **does not exist in TypeScript**: a repo-wide search
finds it only in that markdown file. (`recall.ts` has a `sessionContext`
word-overlap re-score, `recall.ts:28` and `recall.ts:69-86`, but it is not the
spec'd method and does not use embeddings.)

This matters here: **the rule in §2 MUST be in place before any re-ranker
ships.** Per the §0 quote, ranking is not an authorization boundary. A re-ranker
that raises a poisoned memory's score makes the injection *more* reliable, not
less — it changes which poisoned memory wins, never whether poisoning is
possible.
