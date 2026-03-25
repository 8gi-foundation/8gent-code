# ADHD Mode v2 - Quarantine

## Problem

ADHD mode currently only provides bionic text (bold first half of words). Users with ADHD need active focus tools - timers, task decomposition, distraction awareness, and positive reinforcement - not just a text rendering tweak.

## Constraint

Ship as a standalone toolkit (~140 lines) with zero changes to existing files. Integration into the TUI provider happens in a follow-up after validation.

## Not doing

- Not modifying the existing ADHDModeContext or providers.tsx
- Not adding TUI components yet (that is a separate PR)
- Not adding audio playback (celebration triggers return intent objects, playback is handled by the music package later)

## What is in this PR

**File:** `packages/proactive/adhd-toolkit.ts`

### 1. Focus Timer (Pomodoro)

`FocusTimer` class with configurable work/break/long-break intervals. Defaults to 25/5/15. Emits tick, work-end, break-end, long-break-end events via callback.

### 2. Task Breakdown

`breakdownTask(description, totalMinutes, chunkMinutes?)` splits any task into 5-minute chunks (configurable). Returns an array of `Chunk` objects with completion tracking.

### 3. Distraction Blocker

`DistractionBlocker` logs context switches and warns when the user exceeds a threshold (default: 5 switches in 10 minutes). Pure logging - does not block anything, just surfaces awareness.

### 4. Celebration Triggers

`celebration(done, total)` returns intent objects (`confetti`, `sound`, `message`) based on progress milestones. First chunk, every 3rd chunk, and final chunk all trigger different celebrations.

### 5. Progress Visualization

`progressSnapshot(chunks, startedAt)` returns a snapshot with done/remaining counts, percentage, elapsed time, and an ASCII progress bar.

## Success metric

- All 5 features are independently callable from agent code or TUI
- Zero existing files modified
- Can be wired into ADHDModeContext in a single follow-up PR

## Next steps

1. Wire into TUI: add FocusTimer widget to the chat sidebar
2. Hook DistractionBlocker into view-switch events
3. Connect celebration sound triggers to the music package
4. User testing with ADHD users for feedback on defaults
