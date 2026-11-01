# Grounding eval

Measures `ground(screenshot, instruction)` on screenshots of our own surfaces.
A hit is the returned click point inside the target's box.

## The set

`build-set.ts` builds 20 screenshots with 53 targets through 8gent Browser's
loopback control server (`ws://127.0.0.1:7980`, token-gated). The browser itself
measures each box with `getBoundingClientRect`, so no box is drawn by hand.

| Source | Screenshots | Targets | What |
|---|---|---|---|
| test-page | 10 | 28 | Local pages in `pages.ts`: forms, toggles (light and dark), a file table, a modal, an icon toolbar, an inbox, checkout, a calendar, search results |
| tui | 4 | 8 | Real TUI components (approval prompt, command palette, orchestrator pane) rendered headless through Ink, drawn as a monochrome terminal |
| fixture-site | 2 | 5 | The pilot's browser-op fixture server: the sign-in page, then the signed-in settings page |
| 1x-copy | 4 | 12 | 1x downscales of four retina shots, to test a non-retina frame |

All captures are retina (2550x1330 for a 1275x665 viewport). The set is written
to `~/.8gent/ground-eval/set/` and stays out of git.

```bash
TMPDIR=/private/tmp/claude-501 bun packages/eyes/ground/eval/build-set.ts   # needs 8gent Browser running
TMPDIR=/private/tmp/claude-501 bun packages/eyes/ground/eval/run.ts         # default backend
EIGHT_GROUND_BACKEND=qwen3.5 bun packages/eyes/ground/eval/run.ts           # any preset
```

## Results, 12 Oct 2026 (32 GB M-series Mac, models already installed, nothing downloaded)

| Backend | Model | Hit rate | test-page | tui | fixture | 1x | Median / p90 per call |
|---|---|---|---|---|---|---|---|
| `qwen2.5vl` (default) | qwen2.5vl:7b | **51/53 (96.2%)** | 28/28 | 6/8 | 5/5 | 12/12 | 2.1 s / 7.1 s |
| `qwen3.5` | qwen3.5:9b | 37/53 (69.8%) | 21/28 | 3/8 | 3/5 | 10/12 | 4.1 s / 4.6 s |
| `muse-glimmer` | muse-glimmer:30b-mlx | 14/53 (26.4%) | 7/28 | 1/8 | 1/5 | 5/12 | 7.0 s / 21.3 s |
| `gemma4` | gemma-4-26b-a4b-it (LM Studio) | not run | | | | | This build rejects image input |

Notes:
- The two qwen2.5vl misses are both in the TUI command palette (67 and 10 CSS px off).
- muse-glimmer's 39 misses are 38 answers with no parseable box and 1 wrong box.
  When it did answer, it was right 14 of 15 times. Its output format is not tuned
  here, so this row measures format compliance as much as grounding.
- The latency includes the first call on each new image (5-7 s, image encode).
  Repeat calls on the same image take about 1 s.
- `confidence` is a shape heuristic. It does not separate hits from misses on this
  set (both qwen misses scored 1.0), so treat it as a sanity check, not a probability.

## Not measured, needs a download (disk was 4-12 GB free tonight)

UI-Venus-1.5-2B / 8B (Apache-2.0, ScreenSpot-Pro 57.7 / 68.4 by the authors),
UI-TARS-1.5-7B (ScreenSpot-Pro 49.6), Holo4-35B-A3B GGUF (about 20 GB at 4 bit),
GUI-Actor-7B. Each one is a preset line plus `run.ts`. See #4044.
