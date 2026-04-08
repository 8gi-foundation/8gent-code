# Quarantine: Clawverse Game Simulation

## Source

- **Repo:** [genspark-ai/clawverse](https://github.com/genspark-ai/clawverse)
- **License:** MIT
- **Created:** 2026-03-23 (very recent)
- **Claim:** 17,500 lines, 100+ autonomous coding sprints, zero human code
- **Live:** genclawverse.ai

## What Clawverse Is

An isometric browser-based multiplayer island builder. Animal Crossing meets Minecraft in a browser tab. Each player gets a persistent island to build, farm, trade, and raid.

### Core Game Mechanics

1. **Isometric Grid World** - 32x32 tile grid, height layers (z 0-7), 128x64 pixel isometric diamonds. Painter's algorithm rendering (row ASC, col ASC, z ASC).

2. **Island Types** - 4 types (farm, fish, mine, forest), each with primary/secondary/weak resource yields. Creates natural trade dependencies between players.

3. **Resource Gathering** - Time-gated plots (1-5 min growth cycles, 3 stages: planted/growing/harvestable). Primary zone 4x4 (5x yield), secondary 2x2 (1x), weak 1x2 (0.2x).

4. **Crafting** - 12 recipes combining resources into higher-value items: furniture, tools, weapons, defenses. Level-gated (weapons at Lv3).

5. **Dynamic Economy** - Player-to-player marketplace with sell orders. Daily price fluctuation (0.7-1.5x base, turnips 0.5-5.0x). Deterministic weekly patterns (increasing/decreasing/spike/random). 5% trade tax.

6. **Combat/Raiding** - Weapons destroy buildings on enemy islands. Defenses (walls, watchtowers, guard dogs, moats) counter attacks. 24h cooldown per target, 1h newbie protection.

7. **Social** - Visit other islands, leave marks, guestbook, emoji reactions, gift system, crop stealing (QQ Farm style).

8. **Daily Spin** - Gacha-style daily reward.

### Tech Stack

- **Backend:** Python (Flask) + SQLite - monolithic 4,500-line app.py
- **Frontend:** Vanilla JS + HTML5 Canvas - monolithic 13,000-line index.html
- **Auth:** Email-based verification
- **Hosting:** Caddy + Azure VM
- **No frameworks, no game engine** - everything hand-rolled

### Architecture Assessment

Honest take: it is a working proof of concept but architecturally rough. Single-file monoliths on both frontend and backend. No modularity, no tests, no type safety. The "100+ autonomous sprints" produced quantity, not quality. The interesting part is the game design, not the code.

---

## How It Maps to 8gent.games

Our existing vision: AI civilisation simulator, Dublin as first city, Paperclip economy. Here is the mapping:

| Clawverse | 8gent.games | Adaptation |
|-----------|-------------|------------|
| Player island | Agent territory (Dublin district) | Each AI agent manages a district |
| 4 island types | District specializations | Tech, culture, trade, industrial |
| Resource gathering | Agent-driven production | Agents autonomously gather resources based on their personality |
| Crafting recipes | Technology tree | Combining resources creates capabilities |
| Dynamic pricing | Paperclip economy | Supply/demand simulation with agent-driven market |
| Player raids | Agent competition | Agents can compete for territory/resources |
| Social visits | Agent diplomacy | Agents visit, negotiate, form alliances |
| Daily spin | Emergence events | Random events that disrupt equilibrium |

### Key Differences

- Clawverse is a **player game** - humans click tiles. 8gent.games is an **agent simulation** - AI agents make decisions autonomously.
- Clawverse uses a flat 2D economy. 8gent.games should model emergent complexity (Paperclip Maximizer dynamics).
- Clawverse has no AI decision-making. 8gent.games is fundamentally about watching AI agents evolve strategies.

---

## What to Abstract and Rebuild

### Worth abstracting (core patterns under 200 lines each):

1. **Resource/Economy Engine** - Island types with yield multipliers, resource gathering with time gates, dynamic pricing with weekly patterns. This is the heart of any economic simulation. Rebuild as a pure TypeScript module.

2. **Crafting/Tech Tree** - Recipe system: inputs + time = output. Level-gating. Simple and composable. Rebuild as a typed recipe resolver.

3. **Agent Territory Model** - Grid-based territory with specializations. Adapt from player-island to agent-district concept.

4. **Market Simulation** - Order book with dynamic pricing. 5% tax as friction. Price patterns. Rebuild as a simulation tick engine rather than REST API.

### NOT worth abstracting:

- **Isometric renderer** - We will use a modern frontend (React/Next.js), not canvas spaghetti. Use existing libraries if we need isometric view.
- **Flask backend** - We use Bun/TypeScript. No Python.
- **Auth system** - We have our own auth.
- **Frontend UI** - 13,000 lines of vanilla JS in one file. No.
- **Combat system** - Interesting but scope creep for initial prototype.

---

## What Is Genuinely Novel vs What We Already Have

### Novel (worth taking):

1. **Island-type specialization with asymmetric yields** - Creates natural trade dependencies. 5x/1x/0.2x multiplier system is elegant. We do not have this.

2. **Deterministic weekly price patterns** - MD5-seeded price cycles (increasing/decreasing/spike/random). Makes the economy feel alive without randomness being unfair. We do not have this.

3. **Time-gated resource gathering with 3-stage growth** - Simple but effective pacing mechanic. Plant-grow-harvest loop with configurable timers. We do not have this in game form.

4. **Crafting as economic transformation** - Combining low-value resources into high-value goods. The recipe system creates strategic depth (do you sell raw or craft first?).

### Already have (skip):

- **SQLite persistence** - We have `packages/memory/store.ts` with SQLite + FTS5.
- **Agent autonomy** - We have `packages/self-autonomy/` with reflection, evolution, and meta-mutation.
- **Multiplayer/social** - Not relevant for agent simulation.
- **Pixel art rendering** - Not our visual direction.

---

## Rebuild Plan

- **Problem:** 8gent.games needs a core economic simulation engine for AI agent civilisation gameplay.
- **Constraint:** Under 500 lines, TypeScript, deployable to Vercel, no external dependencies beyond Bun.
- **Not doing:** Visual renderer, multiplayer networking, combat system, auth.
- **Success metric:** A simulation that runs 100 ticks and produces emergent economic behavior (agents specializing, price fluctuations, trade happening).
- **Estimated size:** 3 files, under 500 lines total.
