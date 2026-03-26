# 8GI Member Onboarding Guide

Welcome to the circle. If you're reading this, someone in the 8GI community vouched for you, or you showed up on Threads and said something that made us think "this person gets it." Either way, you're here now - let's get you set up.

This guide walks you through everything: what you need, what you're agreeing to, how to install the stack, and what your first session looks like. Read the whole thing before you start. It's not long.

---

## 1. Prerequisites

Before you begin, make sure you have the following:

### Machine
- **macOS or Linux.** Windows works via WSL2, but macOS/Linux is the tested path.
- **8GB+ RAM** recommended. Local models (Ollama) benefit from 16GB+.
- **Terminal comfort.** This is an engineering collective. You should be able to navigate a terminal, run shell commands, and use git without hand-holding.

### Accounts
- **GitHub account.** You'll be added to the [PodJamz](https://github.com/PodJamz) org. This is where the codebases live.
- **Anthropic account with Claude Pro/Max.** Claude Code requires an active Anthropic subscription. This is not optional - Claude Code is the backbone of the setup.
- **Telegram.** Our async comms channel. Download it if you don't have it.

### Skills
- Working knowledge of **TypeScript/JavaScript.** The entire 8gent codebase is TS.
- Basic **git** fluency (branches, PRs, rebasing).
- Willingness to read code you didn't write and figure out how it fits together.

### Optional but helpful
- **Ollama** installed for local model inference (free, private, no API keys).
- An **OpenRouter** account for free cloud models (fallback when local isn't enough).

---

## 2. The Constitution - What You're Signing Up For

Before we give you access, you need to read and agree to the [8GI Constitution](https://8gent.world/constitution). Here's the summary, but read the full version in [8GI-MANIFESTO.md](8GI-MANIFESTO.md).

**The 10 rules:**

1. **No evil.** Don't use this to harm, manipulate, or deceive people.
2. **No hate.** No discriminatory systems, surveillance tools, or hateful content.
3. **No exploitation.** No pornography, no exploiting minors, no consent violations.
4. **No weapons.** No malware, no tools of violence.
5. **No theft.** No data theft, no IP infringement, no unauthorized access.
6. **Privacy is sacred.** Personal data never leaves your machine without explicit opt-in.
7. **Open source is the default.** The core stays MIT. Commercial forks are fine, but what we build together belongs to everyone.
8. **Review before merge.** All LLM-generated code goes through human review + the NemoClaw security gate. No exceptions.
9. **200-line discipline.** No ability exceeds 200 lines. If it can't be simple, it can't ship.
10. **Transparency.** Every step logged, every decision traceable, every output reviewable.

This isn't corporate compliance theater. These rules exist because we're building tools that amplify human capability - and amplification without ethics is dangerous. If any of these feel restrictive to you, this isn't the right collective.

**To confirm your agreement:** Message James directly on Telegram (@jamesspalding) with "I've read the Constitution and I'm in." That's it. No forms, no signatures, no ceremony.

---

## 3. Step-by-Step Setup

### Step 1: Install Bun

Bun is the runtime. Everything runs on it.

```bash
curl -fsSL https://bun.sh/install | bash
```

Verify:
```bash
bun --version
# Should print 1.x.x
```

### Step 2: Install Claude Code

Follow Anthropic's official instructions for Claude Code. You need an active Anthropic subscription (Pro or Max).

```bash
# Install Claude Code CLI
npm install -g @anthropic-ai/claude-code
```

Verify:
```bash
claude --version
```

### Step 3: Install 8gent Code

Two options - pick the one that fits your role.

**Option A: User install (just want to use it)**
```bash
npm install -g @podjamz/8gent-code
8gent  # launch anywhere
```

**Option B: Contributor install (you want to hack on the codebase)**
```bash
# Clone the repo
git clone https://github.com/PodJamz/8gent-code.git
cd 8gent-code

# Install dependencies
bun install

# Launch the TUI from source
bun run tui
```

Most circle members should do Option B. You're here to contribute.

### Step 4: Clone the 8GI Setup Repo

This private repo contains the shared configuration that makes your Claude Code + 8gent setup match what the rest of the circle uses.

```bash
git clone https://github.com/PodJamz/8gi-setup.git
cd 8gi-setup && ./setup.sh
```

**What setup.sh does:**
1. Configures Claude Code with the CORE skill system
2. Installs the 8gent harness alongside Claude Code
3. Sets up NemoClaw security policies (deny-by-default)
4. Configures the factory pipeline connection
5. Sets up the companion system (your coding companion - more on this below)
6. Registers you in the 8GI circle (Telegram group invite, GitHub org access)
7. Runs a verification check

When you see `"Your setup is ready. Welcome to 8GI."` - you're good.

### Step 5: Verify NemoClaw Policies

NemoClaw is the policy engine that keeps everyone safe. It runs deny-by-default, meaning anything not explicitly allowed gets blocked or requires your approval.

Check that your policies are active:
```bash
cat ~/.8gent/policies.yaml
```

You should see rules like:
- **Blocked:** `rm -rf /`, fork bombs, force push to main, writing secrets to files
- **Requires approval:** pushing to protected branches, hard git resets, pipe-to-shell
- **Allowed:** standard git, bun, npm, tsc, ls, cat, mkdir

Don't weaken these policies. They exist for good reason.

### Step 6: Verify the Factory Pipeline

The factory is the system that generates abilities from real-world sources (npm trending, GitHub trending, etc.) and proposes PRs to the shared codebases.

```bash
# Check factory connection
bun run tui
# In the TUI, type: /factory status
```

If connected, you'll see the pipeline status and recent ability proposals.

---

## 4. Your First Session

### What happens when you launch

```bash
cd 8gent-code  # or any project
claude          # start Claude Code
```

Claude Code starts with the 8gent harness loaded. This means:
- Your CLAUDE.md project instructions are active
- NemoClaw policies are enforcing security
- The memory system is learning your patterns (locally, privately)
- The companion system is tracking your session

### What the companion system is

Every coding session contributes to your personal companion - a creature that evolves based on how you code. Think of it like a Tamagotchi that feeds on pull requests instead of food. The more you contribute, the more your companion grows.

This isn't a gimmick. It's a feedback loop. The companion makes coding sessions feel like progress toward something beyond just "I shipped a feature." More details in the [companion docs](COMPANION-SPEC.md) if they exist, or ask in the Telegram group.

### Your first PR

Here's the play-by-play for your first contribution:

1. **Pick a good-first-issue.** Check the [issues page](https://github.com/PodJamz/8gent-code/issues) for anything tagged `good-first-issue` or `help-wanted`.
2. **Create a branch.** `git checkout -b feature/your-thing`
3. **Do the work.** Use Claude Code as your pair programmer. That's the whole point.
4. **Test it.** Run `bun run tui` and verify your change actually works. Never push untested code.
5. **Open a PR.** Push your branch and open a PR against `main`.
6. **Wait for review.** James reviews all PRs initially. As trust builds, other circle members gain review access.

Your first PR doesn't need to be impressive. Fix a typo, improve a test, clean up a comment. The point is to prove the loop works: you code, the agent helps, the PR lands, the collective improves.

---

## 5. Communication Channels

### Telegram Group
The 8GI circle has a private Telegram group. This is where async discussion happens - questions, proposals, show-and-tell, troubleshooting. You'll be invited during setup.

Rules:
- Be respectful. This is a small group and tone matters.
- Ask questions freely. There are no stupid questions when you're learning a new stack.
- Share wins. Landed a PR? Say so. It helps morale.
- No spam, no self-promotion, no crypto pitches.

### GitHub Organization
All code lives under the [PodJamz](https://github.com/PodJamz) GitHub org. You'll get contributor access to relevant repos.

### How we communicate
- **Quick questions:** Telegram group
- **Code discussion:** GitHub PR comments and issues
- **Architecture proposals:** GitHub Discussions or a doc in the repo
- **Urgent issues:** DM James on Telegram (@jamesspalding)

There are no standups, no sprint ceremonies, no Jira. We're async-first. Contribute when you can, at whatever pace works for your life.

---

## 6. Contribution Guidelines

### What makes a good PR

1. **One thing per PR.** Don't bundle unrelated changes. If you fixed a bug and also refactored a module, that's two PRs.
2. **200-line discipline.** If your change exceeds 200 lines, it's probably too big. Break it up.
3. **Tests or it didn't happen.** New features need tests. Bug fixes need regression tests. "It works on my machine" is not a test plan.
4. **No secrets in code.** Use `.env` + `process.env`. NemoClaw will block you anyway, but don't even try.
5. **Describe the why, not just the what.** Your PR description should explain why this change matters, not just what files changed.
6. **Run the app before pushing.** `bun run tui` should launch without errors. This is non-negotiable.

### The review process

1. You open a PR against `main`.
2. NemoClaw's automated security gate runs (secret scanning, path traversal checks, policy validation).
3. James (or a trusted reviewer) does a human review.
4. If changes are requested, address them in new commits (don't force-push over review comments).
5. Once approved, the PR gets merged.
6. Post-merge, automated benchmarks check for regressions.

### What gets rejected
- PRs that touch more than 3 files without prior discussion
- Code that bypasses NemoClaw policies
- Changes without tests
- Wholesale imports of external code (we import concepts, not code - rebuild in <200 lines)
- Anything that violates the Constitution

---

## 7. The Companion System

Your coding companion is unique to you. It's a creature that evolves based on your coding patterns - what tools you use, what kinds of problems you solve, how your sessions go.

**How it works:**
- Every session feeds data into your local companion state (stored in `~/.8gent/`)
- Your companion grows, evolves, and develops traits based on your coding style
- Different coding patterns unlock different species and evolutions
- Your companion data is **local only** - it never leaves your machine

**Why it exists:**
- It makes sessions feel like progress, not just work
- It creates a natural incentive to keep coding
- It surfaces interesting patterns about how you work
- It's fun. Software should be fun sometimes.

The companion system is optional in spirit but built into the flow. You don't have to care about it, but it's there, quietly evolving in the background.

---

## 8. What You Get Back

Let's be honest about the value exchange.

**You get:**
- **A properly configured AI coding setup.** The same harness James uses daily. Not a watered-down version.
- **Escape velocity.** The factory pipeline, the memory system, the ability pool - these compound. Your agent gets better every session. So do you.
- **A community of engineers who give a damn.** Small, curated, no noise. People who actually ship code.
- **Early access to the 8gent ecosystem.** You're using the tools before they're public. Your feedback shapes the product.
- **Credit.** Every contribution is tracked. When 8gent ships publicly, the circle members are credited as founding contributors.

**You give:**
- **PRs to the shared codebases.** Your contributions make the collective smarter.
- **Honest feedback.** What's broken, what's confusing, what's missing.
- **Anonymized usage patterns.** Not your code, not your data - just aggregate signals about which abilities get used and which patterns fail.

This isn't a free labor scheme. If you're not getting value, say so and we'll fix it or you can walk. No hard feelings, no exit interviews.

---

## 9. FAQ

**Q: Do I need to pay for anything?**
A: You need an Anthropic subscription for Claude Code (Pro or Max). Everything else - Bun, 8gent Code, Ollama, the 8GI setup - is free.

**Q: How much time do I need to commit?**
A: There's no minimum. Contribute when you can. Some members ship a PR a week, some ship one a month. Quality over quantity.

**Q: Can I use 8gent for my own projects?**
A: Yes. Your 8gent setup is yours. Use it for whatever you want. The companion and memory system are local to your machine. Just follow the Constitution when contributing back to the collective.

**Q: What if I break something?**
A: NemoClaw's policies make it hard to break anything critical. Protected branches require approval, destructive commands are blocked, and all changes go through review. If you somehow do break something, tell the group. Honesty fixes things faster than hiding.

**Q: What models does 8gent use?**
A: By default, Ollama with Qwen 3.5 for local inference (free, private). OpenRouter free models as cloud fallback. The task router auto-selects based on complexity. No API keys needed to start.

**Q: Is my code private?**
A: Yes. Your personal projects, your memory store, your companion data - all local to your machine in `~/.8gent/`. The factory pipeline only processes anonymized patterns, never raw code or personal data.

**Q: Can I invite someone?**
A: Not directly. Suggest them to James. The circle grows by invitation and demonstrated commitment. We'd rather have 10 engaged members than 100 lurkers.

**Q: What if I disagree with a Constitution rule?**
A: Raise it in the Telegram group. The Constitution isn't sacred text - it evolves. But it evolves through discussion, not unilateral action.

**Q: What's the tech stack?**
A: Bun runtime, TypeScript everywhere, Ink v6 (React for CLI) for the TUI, SQLite for memory, YAML for policies. Monorepo structure with `apps/` and `packages/`. Check the [CLAUDE.md](../CLAUDE.md) for the full architecture.

---

## 10. Troubleshooting

### Bun install fails
```bash
# If curl install fails, try npm
npm install -g bun

# On macOS with Homebrew
brew install oven-sh/bun/bun
```

### Claude Code won't start
- Verify your Anthropic subscription is active
- Run `claude --version` to confirm installation
- Check `claude doctor` for diagnostic output
- Make sure you're not behind a corporate proxy that blocks Anthropic's API

### `bun run tui` crashes on launch
- Run `bun install` again - a dependency might be missing
- Check Node/Bun version: `bun --version` (need 1.x+)
- Look at the error output - if it mentions a missing package, install it explicitly

### NemoClaw blocks a legitimate command
- Check `~/.8gent/policies.yaml` to understand why
- If the policy is too restrictive for your use case, raise it in the Telegram group
- Don't weaken policies without discussion - they protect everyone

### Git push rejected
- Make sure you're on a feature branch, not `main`
- Protected branch pushes require approval through NemoClaw
- Force push to `main` is blocked entirely - this is by design

### Factory pipeline not connecting
- Verify your internet connection
- Check that setup.sh completed successfully
- Run `bun run tui` and try `/factory status`
- If it shows disconnected, check the Telegram group for any outage notices

### Companion not appearing
- The companion initializes after your first full session
- Check `~/.8gent/` for companion data files
- If the directory is empty, re-run the setup script

### "Permission denied" errors
- Don't use `sudo` to fix permission issues with npm/bun globals
- Instead: `mkdir -p ~/.npm-global && npm config set prefix ~/.npm-global`
- Add `export PATH=~/.npm-global/bin:$PATH` to your shell profile

### Everything is broken and nothing works
- Take a breath
- Run the setup script again: `cd 8gi-setup && ./setup.sh`
- If it still fails, paste the full error output in the Telegram group
- Someone will help. That's what the circle is for.

---

## Welcome

You're in. The setup takes about 15 minutes if everything goes smoothly. Your first PR can happen the same day.

The 8GI collective gets smarter every time a member ships code, files a bug, or asks a question that nobody thought to ask before. That's the whole idea - not one superintelligent AI, but a network of humans and their agents collaborating at a pace that no individual could match.

Go build something.

---

*Last updated: 2026-03-26*
*Questions? Telegram group or DM @jamesspalding*
