# video-script-builder

Video script builder with hook, body segments, b-roll notes, and CTA for YouTube/short-form.

## Requirements
- buildScript({ title, duration, audience, goal })
- addSegment(script, { timecode, narration, visual, bRoll? })
- hook(topic, style?): generates attention-grabbing opening line
- cta(goal, platform): generates platform-appropriate call-to-action
- renderTeleprompter(script): clean narration-only view

## Status

Quarantine - pending review.

## Location

`packages/tools/video-script-builder.ts`
