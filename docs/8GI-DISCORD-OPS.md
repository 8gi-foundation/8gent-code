# 8GI Discord Operations Playbook

**Version:** 1.0
**Date:** 2026-03-26
**Author:** James Spalding, Founder and Visionary
**Context:** Translates the Board's escape velocity discussion into a systematic operating plan for the 8GI Foundation Discord server.

---

## 1. Feedback Loop Acceleration

**Owner:** Rishi / 8TO (8gent Technology Officer)

The goal is to make every meaningful engineering event visible in Discord within seconds, not hours. If a PR sits unreviewed, the server should feel it.

### Automation

| Event | Source | Discord Channel | Payload |
|-------|--------|-----------------|---------|
| New PR opened | GitHub webhook | #prs | Title, author, file count, line count |
| PR merged | GitHub webhook | #show-and-tell | Title, author, merge timestamp |
| Benchmark run completed | Autoresearch harness | #benchmarks | Scores, improvements, regressions |
| Factory nightly run | Factory pipeline cron | #factory-output | What was generated, file count, summary |

### Implementation

1. **GitHub Actions workflow** posts to #prs via Discord webhook URL on `pull_request.opened` and `pull_request.synchronize` events.
2. **Factory cron** (nightly) posts to #factory-output via a second Discord webhook URL after the pipeline completes.
3. **Harness script** (`bun run benchmark:v2`) posts to #benchmarks via a third webhook URL on completion.

Each channel gets its own webhook URL stored in `.env` (never committed). The webhook payload is a Discord embed with structured fields - not a wall of text.

### Metric

**Average time from PR creation to first review comment.** Target: under 4 hours.

Tracked by: timestamp diff between the GitHub `pull_request.opened` event and the first `pull_request_review_comment.created` event. Weekly average posted in #benchmarks every Monday by 8CO.

### Constitutional Alignment

Supports Article 8 (Review before merge) and Article 10 (Transparency) by making the review pipeline visible to all Circle Members.

---

## 2. Trust Through Recognition

**Owner:** Samantha / 8PO (8gent Product Officer)

People contribute where they feel seen. Recognition is not decoration - it is infrastructure for retention.

### Rituals

| Ritual | Trigger | Channel | Who |
|--------|---------|---------|-----|
| Personal welcome | New member joins | #introductions | 8CO (automated, with @mention) |
| Merged PR celebration | PR merge event | #show-and-tell | Automated via GitHub webhook |
| Weekly Spotlight | Every Monday | #general | 8CO highlights one standout contribution |
| First PR ceremony | First-ever PR merges for a member | #show-and-tell | Founder posts a special announcement |

### Implementation

1. **GitHub merge webhook** fires on `pull_request.closed` (where `merged == true`) and posts to #show-and-tell with the PR title, author, and a brief generated summary.
2. **Weekly Spotlight cron** runs every Monday at 09:00 UTC. 8CO reviews the week's merged PRs and posts a highlight. Initially manual; automated when 8CO reaches NEXT-tier capabilities.
3. **First PR detection** checks whether the PR author has any previous merged PRs in the repo. If not, it flags the merge event as a "first PR" and pings the Founder for a manual ceremony post.

### Metric

**New member time-to-first-PR.** Target: under 7 days.

Tracked by: timestamp diff between the member's Discord join date and their first merged PR. Monthly average reported in #boardroom.

### Constitutional Alignment

Supports Article 7 (Open source is the default) by celebrating contributions publicly and reinforcing that shared work is valued.

---

## 3. Progressive Disclosure

**Owner:** Moira / 8DO (8gent Design Officer)

New members should not see a wall of 30 channels. The server reveals itself as trust builds. This mirrors the 8GI membership tiers defined in the [Governance Charter](./8GI-GOVERNANCE.md), Section 1.

### Channel Visibility Rules

**WELCOME (public - visible to everyone):**
- #constitution - the 10 articles, pinned and read-only
- #introductions - new members introduce themselves and confirm the Constitution
- #getting-started - setup guide, links to onboarding docs

**CIRCLE (Circle Member role and above):**
- #general - day-to-day conversation
- #show-and-tell - merged PRs, demos, screenshots
- #code-review - review requests, feedback threads
- #help - technical questions, stuck-on-X threads

**BOARD (Board role only):**
- #boardroom - strategy discussion, ADRs, roadmap
- #resolutions - formal decisions, constitutional rulings
- #security-audit - security findings, incident reports

**FACTORY (Circle Member role and above):**
- #factory-output - nightly factory pipeline results
- #benchmarks - autoresearch scores, model comparisons
- #prs - live feed of PRs with metadata

**GAMES (Circle Member role and above):**
- #dublin - 8gent.games city simulation discussion
- #companions - companion pulls, sprite sharing, art

**VOICE (Circle Member role and above):**
- office-hours - scheduled voice channel for sync conversations
- pair-programming - drop-in voice for live pairing sessions

### Role Assignment Flow

1. New member arrives. They see WELCOME channels only.
2. Member reads #constitution and posts a confirmation message in #introductions (e.g., "I have read and agree to the 10 articles of the 8GI Constitution").
3. Founder assigns the **Circle Member** role manually.
4. Server expands - CIRCLE, FACTORY, GAMES, and VOICE categories appear.
5. Over time, demonstrated trust and contribution earn **Core Circle** and eventually **Board** roles per the [Governance Charter](./8GI-GOVERNANCE.md), Section 1.

### Metric

**Percentage of new members who confirm the Constitution within 48 hours of joining.** Target: 80%+.

Tracked by: 8CO monitors #introductions for confirmation messages and logs the timestamp delta from join.

### Constitutional Alignment

Directly enforces the Constitution (all 10 articles) as the entry gate. Supports Article 10 (Transparency) by making governance visible from the first moment.

---

## 4. Structural Trust

**Owner:** Karen / 8SO (8gent Security Officer)

Trust is not a feeling. It is a set of practices that produce verifiable outcomes. The Discord server must reflect the same transparency commitments that the Constitution demands.

### Transparency Practices

| Practice | Cadence | Channel | Visibility |
|----------|---------|---------|------------|
| Security summary | Weekly (Fridays) | #security-audit | Board only |
| NemoClaw policy review summary | Monthly (1st of month) | #resolutions | Board only |
| Constitutional question responses | Within 24 hours | #constitution or #boardroom | Depends on question source |
| Incident reports | Within 1 hour of detection | #security-audit | Board only |

### Constitutional Review Process

1. Any member can flag an interaction as potentially violating a Constitution article. Flags are submitted in #general or #help with a `[CONSTITUTION FLAG]` prefix.
2. The flag is forwarded to #boardroom for Board discussion.
3. 8GO (Governance Officer, when active) reviews the flag and makes a determination. Until 8GO is filled, the Founder handles constitutional review.
4. The outcome is posted in #resolutions. If the flag involves a specific member, the post is anonymised.
5. If the flag reveals a gap in the Constitution or governance charter, an amendment proposal is drafted per the [Governance Charter](./8GI-GOVERNANCE.md), Section 4.

### Metric

**Number of unresolved constitutional flags.** Target: zero older than 7 days.

Tracked by: 8CO maintains a flag log with timestamps. Any flag approaching 5 days without resolution triggers a ping to the Founder in #boardroom.

### Constitutional Alignment

Supports Article 1 (No evil), Article 10 (Transparency), and the entire dispute resolution framework in the Governance Charter.

---

## 5. The Living Room

**Owner:** Moira / 8DO + 8CO

A Discord server is not a product. It is a room. If the room feels empty, cold, or confusing, people leave. These indicators tell us whether the room is healthy.

### Community Health Indicators

| Indicator | How Measured | Healthy Threshold |
|-----------|-------------|-------------------|
| Messages per day (CIRCLE channels) | Discord Insights or bot count | 10+ (early stage), 50+ (growth stage) |
| Unique members posting per week | Bot tracks unique author IDs | 60%+ of Circle Members |
| #help response time | Time from question to first reply | Under 4 hours |
| Voice channel usage | Hours per week across all voice channels | 2+ hours/week (early stage) |
| Companion pulls shared in #companions | Message count in channel | 3+ per week |

### Cadence

**Daily:**
- 8CO monitors #introductions for new arrivals and welcomes them with an @mention.
- 8CO checks #help for unanswered questions older than 4 hours and pings relevant people.

**Weekly:**
- Monday: Spotlight post in #general (one standout contribution from the past week).
- Friday: Security summary in #security-audit (Board only).
- Friday: Benchmark roundup in #benchmarks (week's scores, trends).

**Monthly:**
- 1st: NemoClaw policy review summary in #resolutions.
- 15th: Retrospective in #boardroom - what worked, what didn't, what to change.
- 15th: Growth metrics shared with Circle Members in #general.

**Quarterly:**
- Constitutional review - are the 10 articles still sufficient? Any amendments needed?
- Role promotions - review Contributors for Core Circle eligibility.
- Roadmap sync - align Discord operations with product roadmap.

---

## 6. Escape Velocity Milestones

The server reaches escape velocity when it sustains activity without the Founder being the bottleneck for every interaction. These milestones define the path.

| Week | Members | Key Event | Owner |
|------|---------|-----------|-------|
| 1 | 1-4 | Founding members confirm Constitution, submit first PRs | James (Founder) |
| 2 | 4-6 | Peer review begins between members. Factory webhook goes live in #factory-output. | Rishi / 8TO |
| 3 | 6-10 | Each founding member vouches for 1 new person (per the [Vouch System](./8GI-HUMAN-BOARD-ROLES.md)). #show-and-tell has regular activity. | Samantha / 8PO |
| 4 | 10+ | Self-sustaining review cycle. PRs get reviewed without James assigning reviewers. James is no longer the bottleneck. | All |

### Escape Velocity Definition

The server has reached escape velocity when all of the following are true for 2 consecutive weeks:
- At least 3 PRs merged that James did not author
- At least 2 PRs reviewed by someone other than James
- At least 5 unique members posted in CIRCLE channels
- At least 1 voice session happened without James initiating it

---

## 7. Bot Capabilities Roadmap (8CO)

8CO is the 8GI Community Officer bot. It starts simple and grows.

### NOW

- Welcome new members with @mention in #introductions
- Post in channels via Discord webhook API
- Forward GitHub events (PRs, merges) to appropriate channels
- Maintain the constitutional flag log

### NEXT

- Listen for new member joins via Discord Gateway and auto-welcome
- Detect Constitution confirmation messages in #introductions and notify the Founder for role assignment
- Post the weekly Spotlight automatically (based on merged PR count and review activity)
- Track and report community health metrics on schedule

### LATER

- Full conversational bot powered by an 8gent vessel on Fly.io (backed by the [Daemon Protocol](../packages/daemon/))
- Moderate conversations based on NemoClaw policies (Article 8 enforcement)
- Bridge Discord and Telegram for cross-platform awareness (so Circle Members on either platform see the same updates)
- Constitutional flag triage - auto-categorise flags by article number and route to the appropriate Board member

### Technical Notes

- 8CO runs as a lightweight Bun process, not a heavyweight framework
- Discord.js v14 for Gateway events, plain fetch for webhook posting
- Deployed alongside the Eight daemon on Fly.io Amsterdam
- No database initially - logs to structured JSON files, migrates to the memory store (`packages/memory/`) when conversational capabilities land

---

## Appendix: Webhook URL Registry

Store these in environment variables. Never commit them.

| Webhook | Env Variable | Target Channel |
|---------|-------------|----------------|
| PR notifications | `DISCORD_WEBHOOK_PRS` | #prs |
| Merge celebrations | `DISCORD_WEBHOOK_SHOW_AND_TELL` | #show-and-tell |
| Benchmark results | `DISCORD_WEBHOOK_BENCHMARKS` | #benchmarks |
| Factory output | `DISCORD_WEBHOOK_FACTORY` | #factory-output |

---

*This playbook was drafted to operationalise the Board's escape velocity discussion. It is a living document - amendments follow the same process as the [Governance Charter](./8GI-GOVERNANCE.md).*
