---
title: 8gent Capabilities vs Claude Suite + Codex
subtitle: Taxonomy pick, shipped set, stealth call, comparison matrix, positioning
author: Samantha (8PO), 8GI Product Office
date: 2026-04-24
version: v1.0
---

# 8gent Capabilities vs Claude Suite + Codex

Taxonomy pick, shipped set, stealth call, comparison matrix, positioning.

Samantha (8PO), 8GI Product Office. 2026-04-24.

Internal board deck. Future public adaptation informs 8gent-dev #5, #6, #8.

---

# Why this deck exists

One question has been blocking four threads at once.

What is the shape of "abilities" for 8gent, expressed in a way that:

1. Drives the public /abilities docs page on 8gent.dev
2. Drives the feature-scope table in the 8gent Computer PRD (issue #1746)
3. Separates what is shipped, what is roadmap, and what we deliberately hold back
4. Is honestly comparable to Claude Code, Claude Desktop, Claude API, and OpenAI Codex (Apr 16 2026 release)

Three variants were staged by another agent. This deck picks one, names the shipped set, flags the hold-back list, and lands the matrix.

---

# Part 1. Taxonomy pick

The three candidates:

- **Variant A. Body parts.** Organs, autonomy, surfaces, tools. Agent-as-embodiment.
- **Variant B. Feature categories.** Code gen, task automation, memory, voice, safety, enterprise.
- **Variant C. Comparison grid.** 8gent vs Claude Code vs Claude Desktop vs Claude API vs Codex.

**Pick: Variant A. Body parts.**

One-sentence reason: the /abilities v1 vision is a 3D humanoid with an embodied brain and organ map, so the taxonomy must map 1:1 to the anatomy the user will see, and Variants B and C are downstream views of the same data.

This choice becomes the spine of both the public /abilities page and the 8gent Computer PRD feature-scope table. Variant C lives as an appendix in this deck (Part 5) and as a secondary doc page later. Variant B is deprecated.

---

# Why body parts wins

Four reasons, in priority order.

1. **Brand lock.** Memory files lock the agent-as-body frame. 8gent-hands, 8gent-eyes, 8gent-voice, packages/memory, AgentMail are all organ names. Customer copy already uses "hands" not "computer-use".
2. **3D /abilities vision.** The v1 docs page is a humanoid robot with body parts lighting up as abilities ship. Any other taxonomy creates a mismatch between docs and visual.
3. **Future embodiments fit cleanly.** Phone, laptop (Lil Eight shell), drone (web navigator) are non-human bodies. Body-parts taxonomy holds them without breaking. Feature-category taxonomy does not.
4. **Differentiation.** Claude, Codex, Cursor, everyone ships "features". 8gent ships a body. That framing is ours.

The trade-off: body-parts is less familiar to enterprise buyers used to feature-category grids. Mitigation: we carry the feature grid as an appendix and surface it in sales conversations, but the product spine stays anatomy.

---

# Part 2. Canonical shipped set

Working assumption: PRs #1716 through #1727 on 8gi-foundation/8gent-code are the canonical "shipped" list for this cycle.

Verified against gh pr view for each. All 12 merged to main between 2026-04-24 00:27 and 00:31 UTC. No PR in the range is in draft, closed-unmerged, or behind a flag.

| PR | Area | Shipped |
|----|------|---------|
| #1716 | PDF reading tools wired into agent surface | yes |
| #1717 | Fast mode, /fast slash and --fast flag | yes |
| #1718 | MCP server mode, expose 8gent tools | yes |
| #1719 | macOS native push notifications | yes |
| #1720 | Session resume, --resume and --continue | yes |
| #1721 | Email notification channel via Resend | yes |
| #1722 | AI game dev pipeline, sprite slicer + scaffolds | yes |
| #1723 | Routines, named scheduled agent tasks | yes |
| #1724 | Slack notification channel | yes |
| #1725 | Multi-agent adapter protocol | yes |
| #1726 | Bi-directional cross-device session sync | yes |
| #1727 | Vessel-to-vessel mesh protocol | yes |

**Recommendation: accept all 12 as canonical shipped. No additions, no exclusions.**

Rationale: every PR is user-visible from the TUI, daemon, or CLI surface today. None require follow-up PRs to be usable. None expose internal-only APIs.

---

# Part 3. Stealth and hold-back list

What stays off the public /abilities page today. Three customer-visible holds, plus one public-but-flagged.

**Public but clearly labelled "Roadmap" (not stealth, not shipped):**

- **8gent-hands.** The planned fork of trycua/cua for computer-use. James already named it publicly in 8gi repos. Keep it on the public deck and /abilities page labelled **Roadmap** with a short note that the fork work begins after the four consolidation PRs merge. Honest signal beats silence. Do not mark stealth.

**Internal-only, do NOT appear on public docs yet:**

1. **HyperAgent RL kernel.** packages/kernel contains the RL fine-tuning pipeline. Off by default. Still experimental. Exposing it publicly invites expectations we cannot yet meet. Hold until the pipeline has one documented success.
2. **8gent Computer security internals.** Qdrant encrypted volume at `~/.8gent/qdrant/`, Keychain bundle id, sensitivity tiers, COPPA isolation schema for Nicholas. These are implementation details that belong in the PRD and Karen's threat model, not on a public capability page.
3. **aidhd.dev product surface.** Memory-locked stealth per project_aidhd_stealth. Never include in any public deck, roadmap, or ecosystem listing until James lifts the hold.

**Total customer-visible hold-backs: 3.**

---

# Part 4. Body-parts taxonomy, filled with the shipped set

This is the spine. /abilities v1 docs page inherits this structure. 8gent Computer PRD feature-scope table is a re-sort of the same rows.

## Organs (the I/O body)

| Organ | What it does | Status |
|-------|--------------|--------|
| Hands (`8gent-hands`) | Computer-use: click, type, screenshot, read the accessibility tree. Fork of trycua/cua. Background daemon, does not steal focus. | Roadmap |
| Voice | Text-to-speech via KittenTTS. Local model, zero API cost. Any completion can be spoken. | Shipped |
| Memory | SQLite + FTS5 full-text search, sentence-embedding vectors, session checkpoints, concept linking, contradiction detection, dream-time consolidation. Persists across sessions. | Shipped |
| Browser | Headless and headed nav, form fill, screenshot, extraction. Per-site policy gates. | Shipped |
| Email | Read and write via AgentMail. Send notifications through Resend on completion or failure. | Shipped (#1721) |

## Autonomy (the nervous system)

| Ability | What it does | Status |
|---------|--------------|--------|
| Orchestration | Spawn and coordinate sub-agents. Vessel-to-vessel mesh. Sub-orchestration breaks a goal into a DAG of tasks. | Shipped (#1725, #1727) |
| Routines | Named, cron-scheduled, persistent agent tasks with run history, manual and webhook triggers. | Shipped (#1723) |
| Session resume | `--resume` picks up the last session. `--continue <id-or-name>` restores a specific one. | Shipped (#1720) |
| Cross-device sync | Start a session on one machine, finish on another. Tracks originating surface (cli, os, telegram, discord, api). | Shipped (#1726) |
| Self-evolution | Overnight loop reviews prior sessions, extracts lessons, updates prompts and skills. | Shipped |

## Surfaces (the skin)

| Surface | What it is | Status |
|---------|------------|--------|
| TUI | Ink v6 terminal UI. `8gent` command boots it. | Shipped |
| Lil Eight | Native macOS dock pet (Swift/AppKit). Per-session companion. Hosts the companion-deck collection UI. | Shipped (pet); companion-deck role Roadmap |
| 8gent Computer | On-device Mac agent. NSStatusBar item, main window, in-app browser, parallel agents, memory viewer, ethics, schedule, voice. | Roadmap (PRD #1746) |
| MCP server mode | Expose 8gent's tools to external MCP clients: Claude Code, Cursor, custom. `--tools=safe` for read-only. | Shipped (#1718) |
| Fast mode | `/fast` slash or `--fast` flag. Routes to fastest available model: local small first, then free cloud. | Shipped (#1717) |
| Notifications | macOS native push, email (Resend), Slack. Per-event configurable. | Shipped (#1719, #1721, #1724) |

## Tools (the hands hold these)

| Tool | What it does | Status |
|------|--------------|--------|
| PDF | Read, extract text, parse tables, search. Available as `read_pdf`, `read_pdf_page`, `search_pdf`. | Shipped (#1716) |
| AST-first code navigation | Indexes repos as ASTs so file reads return symbols and signatures, not raw bytes. Targets 80%+ token reduction. | Shipped |
| LSP | Language Server Protocol client for type info and diagnostics during edits. | Shipped |
| Tree-sitter | Syntax-aware parsing for Go, JS, TS, Python, Rust. | Shipped |
| Policy engine (NemoClaw) | Deny-by-default permission model. Per-tool, per-surface rules. | Shipped |
| Game dev scaffolds | Sprite-sheet slicer, AI-image prompt templates, Phaser 3 and Pixi.js starters. | Shipped (#1722) |

## Future embodiments (other bodies)

A preview of the 3D v1 vision. Each is a body reaching into a different environment.

| Embodiment | What it becomes | Status |
|------------|-----------------|--------|
| Phone | Mobile companion. Voice-first, notification-aware. Syncs via cross-device session sync. | Roadmap |
| Laptop (Lil Eight shell) | Native desktop orchestrator. Dock pet evolves into a full shell with window management, inter-agent coordination, drag-and-drop tool plumbing. | Shipped (pet), Roadmap (shell) |
| Drone (web navigator) | Headless browser body for long-running autonomous web work. Separate process, separate policy scope. | Roadmap |

---

# Part 5. Appendix. Comparison matrix (Variant C, preserved)

Columns: 8gent Computer (this product, per PRD #1746), Claude Code (CLI), Claude Desktop (chat client), Claude API (raw SDK), OpenAI Codex (Apr 16 2026 release set).

Cells: **shipped**, **roadmap**, **not planned**, **unclear**. Where a competitor's status could not be confirmed from public docs or release notes, the cell says **unclear** rather than guessing.

## Body and I/O

| Capability | 8gent Computer | Claude Code | Claude Desktop | Claude API | OpenAI Codex |
|------------|----------------|-------------|----------------|------------|--------------|
| Computer-use (screen, click, type) | roadmap (8gent-hands) | not planned | not planned | shipped | shipped |
| In-app browser | roadmap | not planned | not planned | not planned | shipped |
| Voice I/O | shipped (KittenTTS, local) | not planned | shipped (partial) | not planned | unclear |
| Image generation | roadmap | not planned | shipped | shipped | shipped |

## Memory and persistence

| Capability | 8gent Computer | Claude Code | Claude Desktop | Claude API | OpenAI Codex |
|------------|----------------|-------------|----------------|------------|--------------|
| Memory persistence (vectors, FTS) | shipped | not planned | shipped (user-preference) | not planned | shipped (preview) |
| Session deck and resume | shipped (Lil Eight deep-link) | shipped (partial) | shipped | not planned | shipped |
| Cross-device session sync | shipped | roadmap | shipped | not planned | shipped |

## Autonomy and orchestration

| Capability | 8gent Computer | Claude Code | Claude Desktop | Claude API | OpenAI Codex |
|------------|----------------|-------------|----------------|------------|--------------|
| Parallel agents without session hijack | shipped | unclear | not planned | not planned | shipped |
| Scheduled wake-ups (routines, cron) | shipped | not planned | not planned | roadmap | shipped |
| Self-evolution (reflection loop) | shipped | not planned | not planned | not planned | not planned |

## Safety, local-first, extensibility

| Capability | 8gent Computer | Claude Code | Claude Desktop | Claude API | OpenAI Codex |
|------------|----------------|-------------|----------------|------------|--------------|
| Local-first default | shipped | not planned | not planned | not planned | not planned |
| Ethics toggles (deny-by-default policy) | shipped | shipped | not planned | not planned | shipped |
| MCP server mode | shipped | shipped | shipped | not planned | not planned |

Note on sourcing: competitor cells drawn from Claude Code docs, Claude Desktop release notes, Anthropic API reference, and the OpenAI Codex April 16 2026 announcement. Anywhere public docs are silent, the cell says unclear.

---

# Part 6. 8gent Computer positioning (~80 words)

**The agent IS the computer.**

Claude Code gives you a brain in your terminal. OpenAI Codex gives you a body that clicks around your screen. 8gent Computer is both, on-device. Brain via orchestration, memory, ethics, self-evolution. Body via 8gent-hands, the in-app browser, voice, and the NSStatusBar presence. Local by default, cloud when you choose. The agent does not live inside your Mac. The Mac becomes the agent. Apple Computer became Apple. 8gent Computer becomes 8gent.

---

# Part 7. What this unblocks

- **8gent-dev #5.** Capability taxonomy is picked (Body parts). Public /abilities page uses Variant A as the spine, with Variant C as an appendix page.
- **8gent-dev #6.** The table-based stub can merge as v0 with the body-parts structure above. v1 becomes the 3D humanoid rendering (see docs/design/2026-04-24-abilities-3d-spec.md on 8gent-dev).
- **8gent-dev #8.** Feature comparison page inherits the matrix in Part 5.
- **8gent-code #1746.** PRD feature-scope table is a re-sort of the Body-parts spine into the Codex-parity frame.

---

# Part 8. What is NOT in this deck

- Pricing. That is Zara's surface.
- Release timing beyond what the PRD states.
- Tagline, hero copy, marketing assets.
- aidhd.dev. Stealth-locked.
- Security internals (Qdrant encryption, Keychain, COPPA routing). Internal only, lives in the PRD.
- HyperAgent RL kernel. Internal only until it has a documented success.

---

# Sign-off

Samantha (8PO), 8GI Foundation Product Office.

2026-04-24.

Next action: James reviews and either approves or sends back. On approval, a follow-up PR on 8gent-dev wires Variant A into /abilities as v0, with Variant C preserved as the appendix page.
