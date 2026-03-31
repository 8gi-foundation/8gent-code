# Competitor research: instructkr/claw-code harness patterns

**Status:** Research note for Eight engineers. **Not** a license to copy source. Treat [instructkr/claw-code](https://github.com/instructkr/claw-code) as a **market reference** for how a modern agent harness is structured (inventory, routing, trust, sessions, cost, graphs).

**Related:** GitHub [#1076](https://github.com/8gi-foundation/8gent-code/issues/1076). Local clone (optional): `git clone https://github.com/instructkr/claw-code.git`

---

## 1. Why this repo matters

It is getting outsized attention because it packages **harness engineering** in a legible way: command surface, tool surface, permission filtering, session lifecycle, and **inspectability** (Markdown reports, graphs, parity-style audits). Whether or not you agree with the backstory, the **shape** of the system is what product teams copy: discoverability, trust gates, and operational clarity.

Eight should **abstract patterns**, not vendor their implementation language (Python vs Bun) or any third-party snapshot.

---

## 2. Layered architecture (deep map)

| Layer | claw-code concept | What it does | Eight analogue / gap |
|-------|-------------------|--------------|------------------------|
| **Workspace context** | `PortContext` (`context.py`): roots for src, tests, assets, optional archive | Single object answers “what is on disk?” for reports | `8gent doctor`, workspace index; align with `docs/REPO-CONTEXT-SPEC.md` |
| **Setup / bootstrap** | `WorkspaceSetup` + `SetupReport` (`setup.py`): Python version, platform, ordered `startup_steps()` | Deterministic startup narrative | First-run and `bun run` health; tie to `packages/eight` init |
| **Prefetch** | `PrefetchResult` (`prefetch.py`): named parallel warmups (simulated MDM, keychain, project scan) | **Staged IO** before heavy work | Prefetch embeddings, model list, policy YAML; avoid blocking TUI |
| **Trust + deferred init** | `DeferredInitResult` (`deferred_init.py`): plugin/skill/MCP/hooks gated on `trusted` | **Two-phase boot**: safe shell vs full power | NemoClaw trust modes; `docs/permissions.md` |
| **System init string** | `build_system_init_message()` (`system_init.py`): aggregates setup + inventory counts | **Model-facing** bootstrap summary | System prompt segment that reflects loaded tools, policies, skills count |
| **Command graph** | `CommandGraph` (`command_graph.py`): builtins vs plugin-like vs skill-like | **Taxonomy** of slash commands | BMAD slash commands, skills registry [#983](https://github.com/8gi-foundation/8gent-code/issues/983) |
| **Tool pool** | `ToolPool` + `assemble_tool_pool()` (`tool_pool.py`) | Assembled list with flags: `simple_mode`, `include_mcp`, permissions | “Safe subset” mode for untrusted projects; MCP toggle |
| **Tool filtering** | `get_tools(simple_mode, include_mcp, permission_context)` (`tools.py`) | **Progressive disclosure**: shrink surface | Map to NemoClaw + ToolGate [#988](https://github.com/8gi-foundation/8gent-code/issues/988) |
| **Execution registry** | `ExecutionRegistry` (`execution_registry.py`): unified lookup for mirrored command/tool by name | **Single dispatch table** | `packages/eight/tools.ts` registry pattern; one place to audit |
| **Routing** | `PortRuntime.route_prompt()` (`runtime.py`): token overlap scoring over inventories | Cheap **intent → candidate tools/commands** | Debug UX: “what would match this utterance?” |
| **Bootstrap session** | `bootstrap_session()` → `RuntimeSession.as_markdown()` | One **exportable** artifact: context + setup + routing + exec + stream placeholders | Support bundle, CI artifact, incident export [#981](https://github.com/8gi-foundation/8gent-code/issues/981) |
| **Query engine** | `QueryEnginePort` (`query_engine.py`): turn caps, token budget, compaction, `TurnResult` | **Stateful loop** with stop reasons | Align with `docs/COMPACTION-SPEC.md`, loop detection [#975](https://github.com/8gi-foundation/8gent-code/issues/975) closed |
| **Transcript** | `TranscriptStore.compact(keep_last)` (`transcript.py`) | **Sliding window** without full drop | Session compaction policy |
| **Session persistence** | `StoredSession` JSON + `.port_sessions` (`session_store.py`) | Minimal durable session | Team sessions [#1051](https://github.com/8gi-foundation/8gent-code/issues/1051), daemon [#956](https://github.com/8gi-foundation/8gent-code/issues/956) |
| **History log** | `HistoryLog` (`history.py`): titled events for Markdown export | Human-readable **audit trail** | Agent run history, not just chat messages |
| **Cost** | `CostTracker` (`cost_tracker.py`): labeled unit events | **Attribution** of spend | Kernel budget, provider routing (see `packages/kernel` / proxy) |
| **Models** | `PermissionDenial`, `UsageSummary`, `PortingBacklog` (`models.py`) | Shared **typed** cross-cutting concerns | Zod/TS types for denials + usage in one module |
| **Parity audit** | `parity_audit.py` + `ARCHIVE_ROOT_FILES` | **Traceability** from reference names to ported modules | Eight: parity of **our** tools vs documented capability matrix (no external TS archive required) |
| **Bootstrap graph** | `BootstrapGraph` (`bootstrap_graph.py`): ordered stages | **Documented boot pipeline** | Onboarding diagram for support; link `docs/hooks.md` |
| **Remote modes** | `remote_runtime.py`, `direct_modes.py` | Named transport modes (placeholders) | SSH, remote worker, deep links: compare ACP [#974](https://github.com/8gi-foundation/8gent-code/issues/974), RPC `docs/RPC-MODE-SPEC.md` |
| **Stream events** | `stream_events` tuple on `RuntimeSession` | **Structured** stream for UI/debug | SSE / tool events in TUI |
| **Placeholder subsystems** | Many `src/*/__init__.py` packages with JSON snapshots | **Subsystem registry** with metadata | Extension system `docs/EXTENSION-SYSTEM-SPEC.md` |

---

## 3. Product patterns worth copying (no code)

1. **Everything is inspectable.** CLI subcommands that dump Markdown (`summary`, `manifest`, `setup-report`, graphs) lower support cost. Eight: `8gent capabilities`, `8gent explain-route "<text>"`.

2. **Trust is explicit.** Deferred init only runs when trusted. Eight: same for MCP, plugin load, shell tools.

3. **Three-way command taxonomy.** Builtin vs plugin vs skill-like commands. Eight: core slash vs `.opencode` skills vs third-party.

4. **Tool pool modes.** `simple_mode` (Bash/File only) and `include_mcp` toggle. Eight: “safe mode” for unknown repos.

5. **Unified execution registry.** One lookup for “run command by name” or “run tool by name”. Eight: fewer ad hoc branches in the agent loop.

6. **Exportable session report.** `RuntimeSession.as_markdown()` is a **support contract**. Eight: one command to bundle context for GitHub issues.

7. **Routing as a first-class debug tool.** Token overlap is naive but **fast**; we can replace with embeddings later. Eight: ship **something** before perfect RAG.

8. **Parity audit mindset.** Map “what we claim” to “what exists”. Eight: CI check: tools in docs match `tools.ts` exports.

9. **Bootstrap graph as documentation.** Stages listed in order. Eight: single source of truth for startup sequence in `docs/` + tests.

10. **Cost tracking as events.** Labeled ledger, not one total. Eight: per-tool, per-provider attribution.

---

## 4. Cross-reference to our specs (read these first)

| Topic | Internal doc |
|-------|----------------|
| Compaction / turn budget | `docs/COMPACTION-SPEC.md` |
| Hooks | `docs/hooks.md` |
| Extension / plugins | `docs/EXTENSION-SYSTEM-SPEC.md` |
| Repo context | `docs/REPO-CONTEXT-SPEC.md` |
| RPC / modes | `docs/RPC-MODE-SPEC.md` |
| Harness plan | `docs/HARNESS-PLAN.md` |
| Permissions | `docs/permissions.md` |
| Branching | `docs/SESSION-BRANCHING-SPEC.md` |

---

## 5. Suggested engineering priorities (from this research)

Tracked as **detailed GitHub issues** (epic: [#1076](https://github.com/8gi-foundation/8gent-code/issues/1076)):

| Priority | Issue | Title |
|----------|--------|--------|
| P0 adj. | [#1083](https://github.com/8gi-foundation/8gent-code/issues/1083) | Progressive tool surface (safe subset + MCP toggle) |
| P1 | [#1077](https://github.com/8gi-foundation/8gent-code/issues/1077) | Route-debug CLI |
| P1 | [#1078](https://github.com/8gi-foundation/8gent-code/issues/1078) | Exportable support bundle (Markdown) |
| P2 | [#1079](https://github.com/8gi-foundation/8gent-code/issues/1079) | CI internal capability parity check |
| P2 | [#1080](https://github.com/8gi-foundation/8gent-code/issues/1080) | Bootstrap pipeline docs + tests |
| P3 | [#1084](https://github.com/8gi-foundation/8gent-code/issues/1084) | Labeled cost attribution events |

**Also filed:** [#1081](https://github.com/8gi-foundation/8gent-code/issues/1081) prefetch, [#1082](https://github.com/8gi-foundation/8gent-code/issues/1082) system prompt bootstrap segment, [#1085](https://github.com/8gi-foundation/8gent-code/issues/1085) unified execution registry, [#1086](https://github.com/8gi-foundation/8gent-code/issues/1086) structured agent history, [#1087](https://github.com/8gi-foundation/8gent-code/issues/1087) TUI stream events, [#1088](https://github.com/8gi-foundation/8gent-code/issues/1088) transcript sliding window, [#1089](https://github.com/8gi-foundation/8gent-code/issues/1089) central TS types, [#1090](https://github.com/8gi-foundation/8gent-code/issues/1090) command taxonomy, [#1091](https://github.com/8gi-foundation/8gent-code/issues/1091) workspace context report, [#1092](https://github.com/8gi-foundation/8gent-code/issues/1092) trust-gated deferred init, [#1093](https://github.com/8gi-foundation/8gent-code/issues/1093) extension subsystem manifest.

**Existing issues** still apply: ToolGate [#988](https://github.com/8gi-foundation/8gent-code/issues/988), skills registry [#983](https://github.com/8gi-foundation/8gent-code/issues/983), structured logging [#981](https://github.com/8gi-foundation/8gent-code/issues/981), sessions [#1051](https://github.com/8gi-foundation/8gent-code/issues/1051), daemon [#956](https://github.com/8gi-foundation/8gent-code/issues/956), sandbox [#993](https://github.com/8gi-foundation/8gent-code/issues/993).

---

## 6. Changelog

| Date | Author | Note |
|------|--------|------|
| 2026-03-31 | CAO research | Initial deep competitor abstraction; issue #1076 |
| 2026-03-31 | CAO research | Detailed child issues #1077-#1093 |
