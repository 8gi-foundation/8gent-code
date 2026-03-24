/**
 * PetWidget - Ink (React CLI) component for Lil Eight
 *
 * Embeds the terminal pet at the bottom of the TUI.
 * Cross-platform: works on macOS, Linux, Windows.
 *
 * Usage in TUI:
 *   <PetWidget />
 */

import React, { useState, useEffect } from "react"
import { Box, Text, useStdout } from "ink"
import { TerminalPet, renderSpriteToAnsi } from "./terminal-pet.js"

interface PetWidgetProps {
  sessionId?: string
  daemon?: { connected: boolean; sessionId?: string }
}

export function PetWidget({ sessionId = "eight", daemon }: PetWidgetProps) {
  const [frame, setFrame] = useState<{ lines: string[]; x: number; label: string }>({
    lines: [], x: 0, label: sessionId
  })

  const { stdout } = useStdout()
  const width = stdout?.columns || 80

  useEffect(() => {
    const pet = new TerminalPet({ label: sessionId, maxWidth: width })

    pet.onRender = (lines, x, label) => {
      setFrame({ lines, x, label })
    }

    pet.start()
    return () => pet.stop()
  }, [sessionId, width])

  if (frame.lines.length === 0) return null

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box flexDirection="column">
        {frame.lines.map((line, i) => (
          <Box key={i}>
            <Text>{" ".repeat(Math.max(0, frame.x))}</Text>
            <Text>{stripAnsi(line)}</Text>
          </Box>
        ))}
      </Box>
      <Box>
        <Text>{" ".repeat(Math.max(0, frame.x + 4))}</Text>
        <Text dimColor>{frame.label}</Text>
      </Box>
    </Box>
  )
}

// Ink doesn't support raw ANSI in <Text>, so we need a raw renderer
// This component writes directly to stdout for the pet area
export function PetOverlay({ sessionId = "eight" }: { sessionId?: string }) {
  const { stdout } = useStdout()

  useEffect(() => {
    const width = stdout?.columns || 80
    const rows = stdout?.rows || 24
    const pet = new TerminalPet({ label: sessionId, maxWidth: width - 18 })
    const petHeight = 8

    pet.onRender = (lines, x, label) => {
      const startRow = rows - petHeight - 2
      const padding = " ".repeat(Math.max(0, x))

      // Write directly to stdout (bypasses Ink rendering)
      const out = process.stdout
      out.write("\x1b7") // save cursor (DEC)
      for (let i = 0; i < lines.length; i++) {
        out.write(`\x1b[${startRow + i};1H\x1b[2K${padding}${lines[i]}`)
      }
      const labelPad = " ".repeat(Math.max(0, x + 4))
      out.write(`\x1b[${startRow + lines.length};1H\x1b[2K${labelPad}\x1b[2m${label}\x1b[0m`)
      out.write("\x1b8") // restore cursor (DEC)
    }

    pet.start()
    return () => {
      pet.stop()
      // Clear pet area on unmount
      const startRow = rows - petHeight - 2
      for (let i = 0; i <= petHeight + 1; i++) {
        process.stdout.write(`\x1b[${startRow + i};1H\x1b[2K`)
      }
    }
  }, [sessionId, stdout])

  // This component renders nothing in Ink - it writes directly to stdout
  return null
}

function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, "")
}
