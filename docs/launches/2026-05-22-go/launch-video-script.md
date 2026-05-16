# /go Launch Video Script

**Ship date:** 2026-05-22 (Friday)
**Owner:** 8MO (Zara)
**Hook (locked):** "Your laptop just learned the word 'go'. No cloud. No keys. No bill."
**Hard rule:** every frame shows the local model picker (Apple Foundation / LM Studio / Ollama). One cloud-model frame = launch fails.

---

## Format specs

- **Aspect:** 16:9 master, 9:16 vertical re-cut for Threads/IG/Reels.
- **Length:** 60s cut (X, LinkedIn, IG channel). 90s director's cut (YouTube, 8gent.dev hero, Substack embed).
- **Audio:** KittenTTS voiceover (no ElevenLabs, no paid voice). Light typewriter SFX on prompt entry. Sub-bass thump on the verdict stamp. No music bed under VO.
- **Type:** Fraunces 800 for stamps and end card. Inter 600 for terminal overlays.
- **Palette:** dark mode (bg-0 `#0A0908`, accent `#F07A28`). No purple, no pink, no blue-gray.
- **Capture:** real terminal, real Downloads folder, real airplane mode toggle on screen. No mockups, no after-effects fake terminals.
- **Wifi indicator:** menu bar visible whole runtime. When VO says "no cloud", airplane-mode icon is on screen for at least 2 seconds.

---

## 60-second cut (master)

| # | Time | Visual | On-screen text | VO (KittenTTS) | SFX |
|---|------|--------|----------------|----------------|-----|
| 1 | 0.0 - 3.0 | Black. Fraunces 800 white type lands one line at a time. | "Your laptop just learned the word 'go'." | (silence, let the line breathe) | Sub-bass thump on each line |
| 2 | 3.0 - 5.5 | Same black card. Two more lines stamp in. | "No cloud. / No keys. / No bill." | (silence) | Thump x3 |
| 3 | 5.5 - 8.0 | Hard cut to a terminal. 8gent-code TUI open. Bottom status bar shows model picker with Apple Foundation highlighted, Ollama + LM Studio listed beside it. Menu bar shows airplane mode ON. | Lower-third: "Apple Foundation - local - apfel" | "This is 8gent Code. Running on the metal." | Typewriter tap as cursor blinks |
| 4 | 8.0 - 11.0 | Hands type the prompt. Show every keystroke. | Lower-third stays. | "Watch." | Typewriter |
| 5 | 11.0 - 14.0 | Prompt fully typed: `/go organize my Downloads folder by file type and date, dedupe, surface anything sketchy.` Cursor hovers over enter. | The prompt is the only thing on screen besides the model picker. | (silence) | (silence) |
| 6 | 14.0 - 15.0 | Enter pressed. Tiny screen flash. | LiveFocalStrip lights up in accent orange across bottom. One line: "thinking - apfel". | (silence) | Soft click |
| 7 | 15.0 - 22.0 | Speed ramp 4x. Files shuffling. Sub-agent spawn callout in corner. New folders being created: `Images/`, `PDFs/`, `Archives/`, `Code/`, `Installers/`, `Surface/`. | Counter in corner: "Files moved: 0 -> 247". Lower-third flips to "Sub-agent: dedupe". | "It plans. It runs. It checks its own work." | Quick paper-shuffle SFX, low |
| 8 | 22.0 - 28.0 | Cut to before/after split screen. Left: chaotic Downloads. Right: tidy folder tree. Both real Finder windows. | Top stamp: "BEFORE / AFTER" | "Two hundred forty seven files. Sorted by type. Sorted by date. Forty one duplicates removed." | Single thump at "247" |
| 9 | 28.0 - 33.0 | Cut to the `Surface/` folder. Three files highlighted: an `.exe`, an unsigned `.dmg`, a screenshot that looks like a phishing receipt. | Stamp: "Sketchy. Surfaced." | "And three things it thought you should look at twice." | Low thump |
| 10 | 33.0 - 38.0 | Cut back to TUI. Verdict card slides up. Single line: "Done. 247 organized. 41 deduped. 3 flagged." | LiveFocalStrip green-pulse on verdict. Model picker still visible. | "The judge says done. The judge is a different local model. That's the whole point." | Final thump on "done" |
| 11 | 38.0 - 43.0 | Slow tilt-down from terminal to menu bar. Airplane mode icon dead-center frame. Hold. | Stamp lands: "Runs on the plane." (Fraunces 800, accent orange) | "No cloud. No keys. No bill." | Silence under stamp |
| 12 | 43.0 - 50.0 | Crossfade to end card. Wordmark "8gent Code." Fraunces 800, orange period. Below: model picker triad as quiet icons (Apple / Ollama / LM Studio). | URL: `8gent.dev` (Inter 600). Install line below: `npm i -g @8gi-foundation/8gent-code` | "8gent Code. Free. Local. Yours." | Sub-bass final |
| 13 | 50.0 - 60.0 | Hold end card. Bottom right: small ledger receipt scrolls past once with the actual verdict JSON (proof, not decoration). | Tiny type: "Every run leaves a receipt. ~/.8gent/runs/" | (silence) | (silence) |

---

## 90-second director's cut (expansion)

Same script, with these inserts. Keeps the 60s spine intact; adds three beats that earn the extra 30 seconds.

### Insert A - after frame 6 (the "thinking" moment)

**+8 seconds.** Cut to a tight shot of the executor / judge split.

- Lower-third: "Executor: apfel. Judge: Ollama qwen3:14b. Different models on purpose."
- VO: "One model runs. A different one checks. Neither one phones home."
- Visual: two small CPU graphs side by side, both pulsing local.

### Insert B - after frame 8 (before/after)

**+10 seconds.** Subgoal injection moment.

- Cut back to terminal. User types: `/subgoal also rename screenshots with their date taken`
- VO: "Mid-run, you can nudge it. It folds the subgoal in. Keeps going."
- Visual: counter ticks up: "Screenshots renamed: 18".
- Stamp: "/subgoal - mid-run steering."

### Insert C - after frame 10 (verdict)

**+12 seconds.** The ledger reveal.

- Cut to a clean text editor opening `~/.8gent/runs/{run-id}/ledger.jsonl`.
- Scroll through it. Hash chain visible. Each line a turn or judge verdict.
- VO: "Every step is signed. Every verdict is logged. You can prove what happened, to yourself or a regulator."
- Stamp: "Hash-chained ledger. On your disk. Yours."
- Beat of silence.
- Cut to airplane-mode tilt-down as before.

Total: 60 + 8 + 10 + 12 = 90 seconds.

---

## Anti-failure checks (8MO sign-off list)

- [ ] Model picker visible in frames 3, 6, 7, 10. No frame goes more than 4 seconds without it.
- [ ] No cloud model name on screen at any point. Not even in a window behind the terminal.
- [ ] Airplane mode icon visible in frames 3, 11. Verified before publish.
- [ ] No purple, pink, magenta, or blue-gray anywhere in the frame. Accent is `#F07A28` only.
- [ ] No vendor name spoken or written: not Claude, not Anthropic, not OpenAI, not GPT. The competitive callout happens in the Day 3 post, not the video.
- [ ] No em dashes in on-screen text. Hyphens only.
- [ ] KittenTTS voiceover only. No ElevenLabs file in the project bin.
- [ ] Real Finder window in the before/after. No staged mockup.
- [ ] Verdict card text matches `packages/eight/go/verdicts.ts` exactly. No AI-speak.
- [ ] Final stamp reads "Runs on the plane." Not "Works offline" or any softer phrasing.

---

## Asset checklist

| Asset | Format | Owner | Due |
|-------|--------|-------|-----|
| 60s master | MP4 1080p H.264 + 4K master | 8MO | Thu 2026-05-21 EOD |
| 9:16 vertical cut | MP4 1080x1920 | 8MO | Thu 2026-05-21 EOD |
| 90s director's cut | MP4 1080p + 4K | 8MO | Thu 2026-05-21 EOD |
| End card still | PNG 1920x1080 | 8MO | Thu 2026-05-21 EOD |
| Before/after still | PNG 1920x1080 (for static social) | 8MO | Thu 2026-05-21 EOD |
| Transcript file | `transcript.srt` + `transcript.txt` | 8MO | Fri 2026-05-22 AM |

---

## Capture environment

- M-series Mac, macOS 26.x (apfel-eligible).
- 8gent-code on the launch tag.
- Real Downloads folder pre-staged with: 247 mixed files (images, PDFs, installers, archives, code zips, screenshots, 41 intentional duplicates, 3 deliberately sketchy items: unsigned `.dmg`, random `.exe`, fake-receipt screenshot).
- Apfel running locally. Ollama running locally with `qwen3:14b` and a smaller judge model loaded. LM Studio process visible.
- Wifi OFF. Airplane mode ON. This is non-negotiable for credibility.
- Quiet room, single take per segment, raw screen capture at 60fps minimum.
