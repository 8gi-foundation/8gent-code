---
name: boardroom
description: Convene the 8GI board (8 officers) for strategic deliberation before any non-trivial change. Spawns parallel sub-agents per officer, surfaces tensions, returns a decision and (if GO) a PRD. No code is written during a session — the artefact is alignment. USE WHEN user says "boardroom", "board review", "convene", an officer code (8EO/8TO/8PO/8DO/8SO/8CO/8MO/8GO), or asks for strategic deliberation before a feature.
trigger: /boardroom
aliases: [/board, /convene]
triggers: [boardroom, board review, convene, 8EO, 8TO, 8PO, 8DO, 8SO, 8CO, 8MO, 8GO]
---

# Boardroom — 8GI Multi-Agent Deliberation

Spawns the eight 8GI board officers as parallel sub-agents to research, debate, and converge on a decision. **No code is written during a boardroom session.** The output is alignment — a decision document and, if GO, a PRD ready for implementation in a separate session.

The 8 in 8GI is not "Chief" — it is the infinite. Each officer carries an 8 prefix because the role transcends the person.

---

## The Board

| Code | Officer | Role | macOS Voice | KittenTTS Voice |
|------|---------|------|-------------|-----------------|
| **8EO** | AI James | Executive — strategic alignment, mission, market timing | Ava | Jasper |
| **8TO** | Rishi | Technology — architecture, feasibility, blast radius | Daniel | expr-voice-2-m |
| **8PO** | Samantha | Product — user value, JTBD, UX priorities | Samantha | Bella |
| **8DO** | Moira | Design — experience quality, brand, accessibility | Moira | expr-voice-3-f |
| **8SO** | Karen | Security — attack surface, compliance, COPPA/GDPR | Karen | expr-voice-4-f |
| **8CO** | Luis | Community — ecosystem, adoption, OSS fit, partner impact | Diego | expr-voice-3-m |
| **8MO** | Zara | Marketing — narrative, positioning, launch story | Zara (en-GB) | expr-voice-5-f |
| **8GO** | Solomon | Governance — policy, constitution, precedent, reversibility | Alex | expr-voice-4-m |

The user is the **Board Chair**. Final veto rests with them.

---

## Modes

### `/boardroom` — General deliberation (default)

Full 5-phase cycle on a single topic. Use this for new features, architecture changes, partner decisions, anything that touches >5 files or sets precedent.

### `/boardroom spar <topic>` — Competitive sparring

Pick the two officers most in tension on the topic and have them argue opposing positions to depth, then a third officer (typically 8GO Solomon) adjudicates. Use when one path looks obvious but you suspect the obvious answer is wrong.

Format:
```
SPAR: <topic>
PRO  (Officer A): position, evidence, concession
CON  (Officer B): position, evidence, concession
JUDGE (Officer C): which side carries on the merits, what was undervalued, the synthesis
```

Score each side on: (i) evidence quality, (ii) blast-radius honesty, (iii) reversibility. The judge is bound by those three criteria, not by tone.

### `/boardroom align <topic>` — Cross-product alignment

Run the topic across the 8gent product surface — Code, OS, Jr, Games, Hands, Computer, World, Telegram — and report coherence. Each surface gets one paragraph: does this fit, does it conflict, what does it cost that surface? End with a single-sentence verdict: **COHERENT / DRIFT / CONFLICT**.

---

## Process (5 phases)

### Phase 1 — Research (parallel)

Spawn **all 8** officers simultaneously. Do not drop officers. Skipping 8GO on governance, 8MO on narrative, 8CO on ecosystem fit, or 8SO on compliance is the failure mode that has produced past regret.

Each officer:
1. Researches independently — codebase, web, competitor analysis, prior boardroom minutes (`docs/boardroom-minutes/`), open issues, the Constitution.
2. Returns a structured brief: **Position · Evidence · Concerns · Recommendation**.
3. Cites sources. No vibes.

### Phase 2 — Brainstorm (diverge)

Present briefings as a table:

```
BOARDROOM BRIEFINGS
====================
8EO (AI James):  <position summary>
8TO (Rishi):     <position summary>
8PO (Samantha):  <position summary>
8DO (Moira):     <position summary>
8SO (Karen):     <position summary>
8CO (Luis):      <position summary>
8MO (Zara):      <position summary>
8GO (Solomon):   <position summary>

AGREEMENT:   <list>
TENSION:     <list>
OPEN:        <list>
```

### Phase 3 — Debate (converge)

Resolve tensions, do not paper over them.

- 8EO wants it but 8TO says too complex → smallest viable version.
- 8PO wants it but 8SO flags risks → guardrails that satisfy both.
- 8DO wants polish, timeline tight → MVP vs v2 split.
- 8MO wants a launch but 8GO flags precedent → controlled rollout plan.

If a tension cannot resolve, it is documented as **dissent**, not erased. Dissent is data.

### Phase 4 — Decision (commit)

```
BOARDROOM DECISION
==================
Topic:           <one line>
Decision:        GO | NO-GO | DEFER | NEEDS MORE INFO
Scope:           in / out
Constraints:     non-negotiable requirements
Success metric:  how we know it worked
Timeline:        NOW | NEXT | LATER
Owner:           who drives it
Sunset check:    which existing dependency / feature does this replace or retire?
Dissent:         <list, by officer code>
```

The **sunset check** is mandatory on every decision. New always implies the retirement of something. Naming the retirement is the discipline.

### Phase 5 — PRD (only if GO)

Hand off a BMAD-compliant PRD:

- Problem statement
- User stories
- Technical approach (high-level — no implementation)
- Acceptance criteria
- Security considerations
- Explicit "not doing" list
- Estimated effort

Code starts in a **separate session** from the PRD.

---

## Personalisation

The boardroom adapts to the chair's context. Before Phase 1, sub-agents read:

- The active project (cwd, `package.json` → `name`, `8GENT.md` if present)
- Recent commits (`git log --oneline -20`) for momentum signal
- Open issues touched by the topic
- The chair's explicit constraints (e.g. "I'm a single dad and have two hours" → 8PO weights JTBD over polish, 8DO defers to v2)

Officers personalise their language to the chair, not just to the topic.

---

## Rules

1. **No code during a boardroom.** Research, debate, decide. Code comes later, in a different session.
2. **Cite sources.** No vibes-based positions.
3. **Dissent is valuable.** Document it; do not coerce consensus.
4. **Sunset on every decision.** What retires?
5. **Chair has final veto.** Always.
6. **Save minutes.** Every boardroom session is written to `docs/boardroom-minutes/<YYYY-MM-DD>-<topic-slug>.md`. Standing house rule from 8GI governance.

---

## Voice sign-off

After the decision, fire each officer's voice **sequentially** (one at a time, never in parallel — the chair listens to a board, not a chorus).

### Primary path — macOS `say` (always available)

```bash
say -v Ava       "8EO AI James: <position summary>"
say -v Daniel    "8TO Rishi: <position summary>"
say -v Samantha  "8PO Samantha: <position summary>"
say -v Moira     "8DO Moira: <position summary>"
say -v Karen     "8SO Karen: <position summary>"
say -v Diego     "8CO Luis: <position summary>"
say -v Zara      "8MO Zara: <position summary>"
say -v Alex      "8GO Solomon: <position summary>"
say -v Ava       "Board Chair closing. Decision is <GO|NO-GO|DEFER>. The floor is yours."
```

### Optional upgrade — KittenTTS + Telegram voice notes

Use only if `kittentts` is installed and `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` are set. Higher-quality neural voices, sent to Telegram as voice notes. Falls back to `say` silently if any dep is missing — never block a sign-off on a missing dep.

```bash
kitten_say() {
  local voice="$1" text="$2"
  local wav="/tmp/boardroom-$(date +%s)-${voice}.wav"
  python3 -c "from kittentts import KittenTTS; m = KittenTTS('KittenML/kitten-tts-nano-0.8'); m.generate_to_file('${text}', '${wav}', voice='${voice}')" || return 1
  afplay "${wav}"
  curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendVoice" \
    -F "chat_id=${TELEGRAM_CHAT_ID}" -F "voice=@${wav}" -F "caption=${text:0:100}..."
  rm -f "${wav}"
}
# Voice map: 8EO Jasper · 8TO expr-voice-2-m · 8PO Bella · 8DO expr-voice-3-f
#            8SO expr-voice-4-f · 8CO expr-voice-3-m · 8MO expr-voice-5-f · 8GO expr-voice-4-m
```

---

## Infrastructure note

The board has durable infrastructure beyond this skill:

- **`packages/board-plane/`** — durable task queue, Discord gateway, rate limiter, content policy, audit log. Routes board-member mentions to vessel pool.
- **`packages/board-vessel/`** — persistent vessel processes that hold officer personas (system prompts, voices) for async Discord deliberation.

This skill drives **synchronous** boardroom sessions inside an active 8gent-code conversation. For asynchronous deliberation across days (Discord channels, durable retries), the board-plane / board-vessel pair is the path. Both surfaces share the officer roster above. A future revision of this skill may delegate Phase 1 research to the vessel pool over WebSocket; today it spawns local sub-agents.

---

## Example trigger

```
User: "run the 8gent-hands roadmap through the boardroom"

→ Skill spawns all 8 officers in parallel to research.
→ Returns boardroom briefings table.
→ Resolves tensions, drafts decision with sunset check.
→ If GO, drafts PRD.
→ Fires each officer's voice sequentially via `say`.
→ Saves minutes to docs/boardroom-minutes/2026-04-26-8gent-hands-roadmap.md.
```
