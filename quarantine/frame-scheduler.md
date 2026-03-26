# frame-scheduler

Schedule work across animation frames (non-browser, timer-based).

## Requirements
- FrameScheduler with targetFPS
- schedule(fn) queues work for next frame
- isRunning() boolean state
- pause()/resume() control
- Uses setInterval internally (no RAF)

## Status

Quarantine - pending review.

## Location

`packages/tools/frame-scheduler.ts`
