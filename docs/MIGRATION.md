# Migration Guide - Moving to 8gent Code

Switching coding agents is painful. This guide makes it less so. Whether you're coming from Claude Code, Cursor, Aider, or Codex, this document covers what changes, what stays the same, and how to run 8gent alongside your current setup.

---

## Why 8gent Code

Three things set 8gent apart:

1. **Free and local by default.** No API keys required to start. Ollama runs on your machine. OpenRouter free tier handles cloud fallback. Zero cost to evaluate.
2. **Self-evolving.** Eight learns from every session - memory persists, skills accumulate, preferences adapt. Two developers using 8gent for a week will have meaningfully different experiences.
3. **9 built-in ability packages.** Memory, DJ/Music, Worktree orchestration, Policy engine, Evolution, Healing, Entrepreneurship, AST indexing, and Browser - all included, all CLI-callable.

---

## Feature Comparison

| Capability | 8gent Code | Claude Code | Cursor | Aider | Codex |
|------------|-----------|-------------|--------|-------|-------|
| **Cost to start** | Free (Ollama local) | $20/mo (Pro) | $20/mo | API key required | API key required |
| **Local model support** | Native (Ollama) | No | No | Yes (litellm) | No |
| **Cloud models** | OpenRouter free tier | Claude only | Multi-provider | Multi-provider | OpenAI only |
| **Interface** | TUI (terminal) | CLI | IDE (VS Code fork) | CLI | CLI |
| **Persistent memory** | SQLite + FTS5 + embeddings | Project memory files | None | None | None |
| **Self-improvement** | Bayesian reflection, meta-mutation | No | No | No | No |
| **Multi-agent orchestration** | WorktreePool (4 concurrent) | Worktrees (manual) | No | No | No |
| **Permission system** | NemoClaw YAML policy engine | Approval prompts | IDE trust | CLI prompts | Sandbox |
| **Music/ambient** | Built-in DJ, radio, synth | No | No | No | No |
| **AST awareness** | Import graph, test mapping | File-level | Treesitter | Treesitter | File-level |
| **Checkpoint/healing** | Atomic git stash snapshots | No | Undo buffer | Git-based | No |
| **Open source** | Yes | No | No | Yes | Yes |
| **Offline capable** | Yes (with Ollama) | No | No | Yes (local models) | No |

---

## From Claude Code to 8gent Code

### What's different

- **Model layer.** Claude Code is locked to Anthropic models. 8gent routes across Ollama local models and OpenRouter cloud models. The task router picks the right model per task - small models for simple edits, larger models for architecture decisions.
- **Memory.** Claude Code uses flat markdown memory files. 8gent has a full SQLite database with FTS5 search, Ollama embeddings, episodic/semantic/procedural memory types, contradiction detection, and automatic consolidation.
- **Evolution.** Claude Code is stateless between sessions (besides memory files). 8gent runs post-session reflection, tracks skill confidence with Bayesian scoring, and mutates its own behavior via HyperAgent meta-mutation.
- **Cost.** Claude Code requires a Pro subscription or API access. 8gent runs entirely free with local models, or free-tier cloud models via OpenRouter.
- **Orchestration.** Claude Code can spawn sub-agents but manages them manually. 8gent has a WorktreePool that runs up to 4 concurrent agents in isolated git worktrees with filesystem-based messaging.

### What you'll miss (and workarounds)

- **Claude's reasoning quality.** Claude Opus/Sonnet are strong models. Workaround: use OpenRouter to route to Claude models when needed, or use 8gent as an overlay (see below).
- **MCP integrations.** Claude Code has a mature MCP ecosystem. 8gent supports MCP but the integration library is smaller. Bring your own MCP servers - they work.
- **IDE integration.** Claude Code works in VS Code via extension. 8gent is TUI-native. The CLUI (desktop overlay via Tauri) is in development.

### Migration steps

```bash
# 1. Install 8gent
npm install -g @podjamz/8gent-code

# 2. Install Ollama (if you want local models)
brew install ollama
ollama pull qwen3:14b

# 3. Launch in your project
cd your-project
8gent

# 4. Import your Claude Code memory (optional)
# Copy relevant context from .claude/CLAUDE.md into 8gent's first session.
# Eight will extract and persist it to its memory store automatically.

# 5. Run onboarding
# 8gent's smart onboarding auto-detects your stack, asks 3 questions,
# and builds a user profile. Takes about 30 seconds.
```

---

## From Cursor to 8gent Code

### What's different

- **No IDE.** Cursor is a VS Code fork with AI baked in. 8gent is a terminal application. If you live in your editor, this is a shift. If you live in your terminal, this is home.
- **No subscription required.** Cursor charges $20/mo for Pro. 8gent is free with local models.
- **Agent-first, not autocomplete-first.** Cursor excels at inline completions and chat-in-editor. 8gent is a full autonomous agent - it plans, executes multi-step tasks, uses tools, and learns from results.
- **Memory across sessions.** Cursor forgets everything between sessions. 8gent remembers your preferences, your codebase patterns, and what worked before.

### What you'll miss (and workarounds)

- **Inline code completion.** 8gent does not do autocomplete. Use 8gent for planning and multi-file changes, keep a lightweight completion extension in your editor.
- **Visual diff review.** Cursor shows diffs inline. 8gent uses git-based checkpointing. Use `git diff` or your editor's git integration to review.
- **GUI file browser.** 8gent navigates via CLI. Your terminal file manager (lf, ranger, yazi) fills this gap.

### Migration steps

```bash
# 1. Install
npm install -g @podjamz/8gent-code

# 2. Set up local models
brew install ollama && ollama pull qwen3:14b

# 3. Launch alongside your editor
# Open a terminal split/pane next to your editor.
# 8gent works on the codebase while you work in your editor.
cd your-project && 8gent

# 4. Cursor rules file (optional)
# If you have .cursorrules, paste the relevant rules into your
# first 8gent session. Eight will learn and persist them.
```

---

## From Aider to 8gent Code

### What's different

- **No API key to start.** Aider requires you to bring an API key (OpenAI, Anthropic, etc.). 8gent ships with Ollama support and OpenRouter free tier - zero configuration to begin.
- **Richer agent loop.** Aider is an edit-focused tool - it reads files, proposes diffs, and applies them. 8gent is a full agent with tool use, multi-step planning, memory, and self-improvement.
- **Built-in memory.** Aider has no persistent memory between sessions. 8gent maintains episodic, semantic, and procedural memory across all sessions.
- **TUI vs CLI.** Aider is a line-by-line CLI. 8gent is a full terminal UI with panels, status indicators, and keyboard navigation.

### What you'll miss (and workarounds)

- **Simplicity.** Aider is deliberately minimal. 8gent has more moving parts. If you want a simple "edit these files" workflow, 8gent's chat mode handles that, but the full system is more complex.
- **Git commit workflow.** Aider auto-commits every change with descriptive messages. 8gent uses checkpoint-verify-revert healing instead. You control when commits happen.
- **Repository map.** Aider builds a repo map for context. 8gent uses AST indexing (import graphs, test file mapping) for similar but different context building.

### Migration steps

```bash
# 1. Install
npm install -g @podjamz/8gent-code

# 2. Local models (replaces your API key)
brew install ollama && ollama pull qwen3:14b

# 3. Launch
cd your-project && 8gent

# 4. Aider conventions file (optional)
# If you have .aider.conf.yml or CONVENTIONS.md,
# share the contents in your first 8gent session.
# Eight learns and persists the rules automatically.
```

---

## From Codex to 8gent Code

### What's different

- **Not OpenAI-locked.** Codex only works with OpenAI models. 8gent routes across any Ollama model locally and any OpenRouter model in the cloud.
- **No sandbox isolation trade-off.** Codex runs in a strict sandbox - safe, but limited. 8gent uses NemoClaw, a YAML-based policy engine with 11 default rules and configurable approval gates. You get safety without losing capability.
- **Persistent learning.** Codex is stateless. 8gent evolves across sessions.
- **Multi-agent.** Codex is single-threaded. 8gent orchestrates up to 4 concurrent agents in isolated worktrees.

### What you'll miss (and workarounds)

- **OpenAI model quality.** GPT-4o and o3 are strong. Use OpenRouter to access them through 8gent if needed.
- **Sandbox guarantees.** Codex's sandbox is strict by design. 8gent's NemoClaw policy engine is configurable - you can lock it down to similar levels, but the default is more permissive.

### Migration steps

```bash
# 1. Install
npm install -g @podjamz/8gent-code

# 2. Local models (no OpenAI key needed)
brew install ollama && ollama pull qwen3:14b

# 3. Launch
cd your-project && 8gent

# 4. Set policy strictness (optional, for Codex-like safety)
# Edit .8gent/config.json:
# { "permissions": { "mode": "strict" } }
# This requires approval for all file writes and shell commands.
```

---

## Running 8gent as an Overlay

You do not have to choose. 8gent works alongside any other coding agent.

### How it works

8gent operates on the filesystem and git - the same primitives every other tool uses. Run 8gent in a terminal pane while using Claude Code, Cursor, or Aider in another. They share the same working directory and git history.

### Recommended overlay patterns

| Primary tool | 8gent role |
|-------------|-----------|
| Claude Code | Memory layer + orchestration. Let Claude Code do the edits, let 8gent remember context and coordinate multi-agent work. |
| Cursor | Planning + refactoring. Use Cursor for inline edits and completions, use 8gent for multi-file architectural changes. |
| Aider | Agent capabilities. Use Aider for quick single-file edits, use 8gent for complex multi-step tasks. |
| Codex | Model diversity. Use Codex for OpenAI-specific tasks, use 8gent for local/free model workflows. |

### Overlay setup

```bash
# Terminal layout: two panes side by side
# Left: your primary tool
# Right: 8gent

# 8gent watches the same repo, shares git state,
# and persists memory that benefits both workflows.
cd your-project && 8gent
```

### What 8gent adds as an overlay

- **Memory that persists.** Your other tool forgets. 8gent remembers.
- **Multi-agent orchestration.** Delegate subtasks to 8gent's WorktreePool while your primary tool handles the main thread.
- **Free model access.** Route overflow tasks to local Ollama models - no API costs.
- **Music.** Built-in DJ, internet radio, and ambient music while you code.

---

## Common Questions

**Q: Can I use my existing API keys with 8gent?**
Yes. Set `OPENROUTER_API_KEY` in your environment for cloud models. 8gent also works with zero API keys using Ollama locally or OpenRouter's free tier.

**Q: Does 8gent work on Windows?**
8gent runs on macOS and Linux. Windows support via WSL2 works but is not the primary target.

**Q: How big is the local model download?**
Qwen 3 14B is approximately 9GB. Smaller models (7B) are around 4GB. You choose what to pull.

**Q: Will 8gent modify files without asking?**
By default, 8gent's NemoClaw policy engine requires approval for destructive operations. You can configure approval gates from strict (approve everything) to infinite (approve nothing) mode.

**Q: Where is my data stored?**
All data stays in `.8gent/` in your project root. Memory database, config, checkpoints - all local. Cloud sync via Convex is opt-in.
