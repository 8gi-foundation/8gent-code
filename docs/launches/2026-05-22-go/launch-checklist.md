# /go launch - Friday 2026-05-22 go/no-go checklist

**Decision time:** 09:00 IST Fri 2026-05-22
**Ship target:** 14:00 IST Fri 2026-05-22 (X video drop)
**Owner of call:** 8EO (James)
**Failure mode:** any RED below = downgrade to `--experimental` framing per boardroom kill criterion.

---

## Engineering gates (8TO + 8SO + 8PO)

| # | Item | Owner | Verification | Status |
|---|------|-------|--------------|--------|
| 1 | `packages/goal/` merged to main | 8TO | `git log main --oneline -- packages/goal/ \| head -1` returns merge | [ ] |
| 2 | DB migration v2 applied + reversible | 8TO | `bun run db:migrate:dry && bun run db:migrate:rollback:dry` exit 0 | [ ] |
| 3 | Daemon RPC contract published in DAEMON-PROTOCOL.md | 8TO | `grep -c "goal\\.\\(start\\|status\\|stop\\|resume\\|subgoal\\)" docs/specs/DAEMON-PROTOCOL.md` returns 5 | [ ] |
| 4 | 8SO capability budget enforced in daemon (not agent) | 8SO | unit test `packages/permissions/__tests__/budget-enforce.test.ts` green | [ ] |
| 5 | 8SO deny-list hardcoded + non-overridable | 8SO | `bun run test packages/permissions/__tests__/deny-list.test.ts` green, 24/24 cases | [ ] |
| 6 | 8SO secret scrubbing on goal text | 8SO | `bun run test packages/goal/__tests__/scrub.test.ts` green | [ ] |
| 7 | 8SO HMAC state file + tamper detection | 8SO | `bun run test packages/goal/__tests__/state-hmac.test.ts` green | [ ] |
| 8 | 8SO 3-tier kill switch (Ctrl-C, daemon RPC, pkill) | 8SO | manual run + `ps aux \| grep 8gent-daemon` returns empty after each tier | [ ] |
| 9 | Day-3 judge-vs-human eval >= 70% agreement | 8PO | `bun run eval:go:judge-agreement` reports >= 0.70 | [ ] |
| 10 | 20-task local-only eval set baseline recorded | 8PO | `cat eval/go/results/$(date +%F).json \| jq .local_completion_rate` returns >= 0.60 target | [ ] |
| 11 | `verdicts.ts` lint rule active | 8DO | `bun run lint:verdicts` exit 0 (bans: successfully, great news, I've, working on, AI, model, em dash) | [ ] |
| 12 | Verdict copy matches video script | 8DO | `grep "Done\\. .* organized\\. .* deduped\\. .* flagged\\." packages/eight/go/verdicts.ts` returns 1 line | [ ] |
| 13 | Electron surface BLOCKED if 8SO gates not green | 8SO | `docs/specs/SHIP-MATRIX.md` shows Electron=NO for this launch unless gates 4-8 all green | [ ] |

---

## Content gates (8MO)

| # | Item | Owner | Verification | Status |
|---|------|-------|--------------|--------|
| 14 | 60s master video rendered, model picker visible every <=4s | 8MO | manual frame audit + `ffprobe -show_entries frame=pkt_pts_time` cross-check against script timestamps | [ ] |
| 15 | 9:16 vertical re-cut rendered | 8MO | `file launch-2026-05-22-go-vertical.mp4` reports 1080x1920 | [ ] |
| 16 | 90s director's cut rendered (for YouTube + hero) | 8MO | duration check `ffprobe -show_entries format=duration` returns 88-92s | [ ] |
| 17 | Airplane mode icon visible in frame 11 (post-render) | 8MO | manual frame extract at 38s + visual confirm | [ ] |
| 18 | No vendor traces in any frame (Claude/Anthropic/OpenAI/GPT) | 8MO | OCR sweep `tesseract` on every 30th frame, grep returns empty | [ ] |
| 19 | KittenTTS audio embedded, no ElevenLabs file present | 8MO | `find docs/launches/2026-05-22-go -name "*.mp3" -o -name "*.wav" \| xargs grep -l "elevenlabs"` returns empty | [ ] |
| 20 | AIDHD essay drafted + James approval received | 8MO | reply in approval thread "approved for queue" | [ ] |
| 21 | AIDHD essay queued in Substack (NOT published yet) | 8MO | Substack draft URL confirmed, scheduled-for time = Sat 09:00 IST | [ ] |
| 22 | All 17 social posts drafted with copy locked | 8MO | `wc -l docs/launches/2026-05-22-go/social-sequence-72h.md` matches expected | [ ] |
| 23 | Day 0 posts pre-approved by James (X + Threads + LinkedIn + IG + Telegram) | 8MO | approval line per post in Telegram thread | [ ] |
| 24 | Telegram broadcast voice note generated (KittenTTS) | 8MO | file exists at `assets/launch/telegram-vo.mp3`, KittenTTS metadata confirmed | [ ] |
| 25 | README snippet PR opened against 8gent-code main | 8MO | `gh pr list --repo 8gi-foundation/8gent-code --search "readme /go"` returns 1 open PR | [ ] |
| 26 | README snippet merged before 14:00 IST | 8MO | `gh pr view <PR> --json mergedAt` returns timestamp before 14:00 | [ ] |

---

## Governance + ops gates (8GO + 8EO)

| # | Item | Owner | Verification | Status |
|---|------|-------|--------------|--------|
| 27 | Hash-chained ledger writes verified on test run | 8GO | `8gent ledger verify <test-run-id>` exit 0 | [ ] |
| 28 | Convex mirror of ledger live on `/internal/runs` | 8GO | `curl -s -o /dev/null -w "%{http_code}" https://8gi.org/internal/runs` returns 200 (or 401 if auth-gated, also acceptable) | [ ] |
| 29 | EU AI Act voluntary risk assessment one-pager published | 8GO | `ls docs/governance/2026-05-22-go-risk-assessment.md` returns file | [ ] |
| 30 | Boardroom minutes rendered at 8gi.org/minutes/2026-05-16-go-feature | 8GO | curl returns 200 + page contains "8-0 ship" | [ ] |
| 31 | Day-3 kill-gate decision logged in epic #2605 | 8EO | `gh issue view 2605 --comments \| grep "DAY-3 KILL-GATE"` returns log line | [ ] |
| 32 | Ship sign-off comment on epic #2605 | 8EO | `gh issue comment 2605 --body "SHIP: $(date -u +%FT%TZ) - all gates green"` posted | [ ] |
| 33 | Telegram launch announcement queued (not sent yet) | 8EO | message draft in @aijamesosbot scheduled queue | [ ] |

---

## Decision matrix

| Gate state | Action |
|------------|--------|
| All 33 green | SHIP per plan. 14:00 IST X drop. Full social sequence runs. |
| Any engineering gate (1-13) red AND day-3 eval >= 70% | Hold ship. Patch. Re-evaluate at 12:00 IST. If unresolved, downgrade. |
| Day-3 eval (gate 9) < 70% | DOWNGRADE: ship `/go --experimental` flag, reframe Day 0 posts to "early access", no AIDHD essay until eval recovers. |
| Any content gate (14-26) red | Hold the relevant post only. Other posts proceed if their dependencies are green. |
| Any governance gate (27-33) red | Hold full launch. Governance is non-negotiable. |
| Vendor trace found in any frame | Hold launch. Re-render. No exceptions. |
| Cloud model frame found | Hold launch. Re-record. No exceptions. |

---

## Owner roll-up + verification commands

```bash
# Engineering green-roll
bun run test packages/goal/__tests__ \
  && bun run test packages/permissions/__tests__ \
  && bun run lint:verdicts \
  && bun run eval:go:judge-agreement

# Content green-roll (run in worktree)
ls docs/launches/2026-05-22-go/{launch-video-script,demo-script,aidhd-substack-essay,social-sequence-72h,readme-snippet,launch-checklist}.md
ls assets/launch/2026-05-22-go/*.mp4

# Governance green-roll
gh issue view 2605 --repo 8gi-foundation/8gent-code --comments | tail -50
curl -sI https://8gi.org/minutes/2026-05-16-go-feature | head -1
```

---

## Rollback / downgrade script (if downgraded to --experimental)

1. Swap Day 0 X post text:
   ```
   Early access today.
   /go runs locally on your laptop. We're still tuning the judge.
   /go organize my Downloads folder by file type and date, dedupe, surface anything sketchy.
   8gent.dev
   ```
2. Skip the airplane-mode hero stamp on the video; replace with "Early access. Local-first. Tuning in public." card.
3. Defer AIDHD essay one week (Sat 2026-05-30).
4. Defer Day 2 deep-dive one week.
5. Day 3 competitive response converts to "Hermes and Codex shipped this. We're shipping ours local-first, in public, with the receipts on disk. Run it. Send us judge dissent." - shorter, humbler.
6. Telegram broadcast prefaces with: "Early access. Read the receipts before you trust it."

The downgrade is not a failure. The downgrade is the kill criterion working. Ship the version of the launch the eval earns.
