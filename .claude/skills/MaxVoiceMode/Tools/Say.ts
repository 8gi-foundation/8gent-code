#!/usr/bin/env bun
/**
 * Say.ts - sequential local TTS for MaxVoiceMode.
 *
 * Plays each argument as a separate spoken line, strictly one at a time, so
 * voices never overlap. Local macOS `say` only - no cloud TTS.
 *
 * Usage:
 *   bun Say.ts "First line." "Second line."
 *   MVM_VOICE=Daniel bun Say.ts "Custom voice line."
 */
import { spawnSync } from 'node:child_process'

const VOICE = process.env.MVM_VOICE || 'Ava'
const lines = process.argv.slice(2).filter((l) => l.trim().length > 0)

if (lines.length === 0) {
  console.error('Say.ts: nothing to say. Pass one or more lines as arguments.')
  process.exit(1)
}

for (const line of lines) {
  const res = spawnSync('say', ['-v', VOICE, line], { stdio: 'inherit' })
  if (res.error) {
    console.error(`Say.ts: failed to speak ("${VOICE}" voice): ${res.error.message}`)
    process.exit(1)
  }
}
