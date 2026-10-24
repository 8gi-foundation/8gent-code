# Principles and primitives

The 8 principles we build by, and the engineering rules that follow from them. One page. If a change breaks one of these, it is a fix first.

## The 8 principles

Verbatim from `AGENTS.md`, "First Principles". Principle 6 uses "sub-8gents" where the source has an older spelling.

1. **Design first, not last.** Before writing code, think about the interaction. Friction is the enemy. The best interface is the minimum that serves the user.
2. **Free and local by default.** No API keys to start. Local models first. Cloud is opt-in. Privacy is the foundation.
3. **Self-evolving.** Eight gets better every session. Lessons persist. Skills accumulate.
4. **Hyper-personal.** Learn the user's patterns, preferences, codebase, style. Two users should have different experiences after a week.
5. **Accessible.** Key docs have audio. Voice input works. Screen readers work. Adapt to the user, not the reverse.
6. **Orchestrate by default.** Delegate to sub-8gents. Decompose complexity. Use worktrees.
7. **Reduce friction, increase truth.** Prefer voice and conversation over forms.
8. **The work speaks for itself.** Expertise is process, design, communication, and what ships - not credentials or enthusiasm.

## Engineering primitives

Each rule says what we do, then who set it and when.

1. **Local by default.** No user data leaves the device on a default path. Cloud is an explicit opt-in that names where the data goes. Source: James, 24 Oct 2026, "Don't let that happen again".
2. **One install, zero deps.** Core works after one install of 8gent, with no system packages. We pin and checksum our own binaries. Ollama, system installs and cloud are fallbacks or extensions, never the default. Source: James, 24 Oct 2026, "core needs to be one install and boom".
3. **llama.cpp is the local runtime.** The phone defaults to `llama-server` on 127.0.0.1. Ollama is only a fallback for people who already have it. Source: Artale, 24 Oct 2026.
4. **A deterministic tool before a model.** Ask whether code can do the step with no model before patching a prompt. Source: James, 13 Oct 2026.
5. **Nothing goes straight to the model.** Every input path passes one deterministic gate (commands, sanitizer, policy) first. A path that skips it is a fix first. Source: James, 20 Oct 2026.
6. **Install prompts default to No.** Asking is allowed; assuming yes is not. Source: 24 Oct 2026 reviews.
7. **No one at the keys means no.** With nobody to answer, nothing installs and nothing is sent. Source: 24 Oct 2026 reviews.
8. **Fail closed, with a reason.** When a check cannot pass, stop and say why in plain words. Source: 24 Oct 2026 reviews.
9. **Prohibitions hold everywhere.** No em dashes, no secrets in chat, no stat padding, no enthusiasm inflation, no direct push to main. Source: `AGENTS.md`, "Absolute Prohibitions".

## Where it is enforced

Rules 1 and 2 are checked by CI, not by memory: see the [principles gate](security/principles-gate.md) (`scripts/local-first-gate.ts`). A new off-device path or a new install step on a default path fails the build.
