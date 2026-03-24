/**
 * Terminal Pet - Cross-platform Lil Eight rendered in ANSI art
 *
 * Works on macOS, Linux, Windows - anywhere with a terminal.
 * Uses Unicode half-block characters to render 16x16 pixel sprites.
 *
 * Usage:
 *   import { TerminalPet } from "./terminal-pet"
 *   const pet = new TerminalPet()
 *   pet.start()
 */

import { readFileSync, existsSync } from "fs"
import { join } from "path"

// MARK: - Sprite Data (inline fallback if PNG not available)

// 16x16 pixel grid for each frame, stored as color indices
// 0 = transparent, 1 = body (#1A1A2E), 2 = orange (#E8610A), 3 = accent (#FF8C42), 4 = eye (#E8610A)
const PALETTE: Record<number, string> = {
  0: "",           // transparent
  1: "\x1b[38;2;26;26;46m",    // body dark navy
  2: "\x1b[38;2;232;97;10m",   // brand orange
  3: "\x1b[38;2;255;140;66m",  // accent lighter orange
  4: "\x1b[38;2;232;97;10m",   // eye orange (same as brand)
}

const RESET = "\x1b[0m"
const BLOCK_UPPER = "\u2580" // upper half block
const BLOCK_LOWER = "\u2584" // lower half block
const BLOCK_FULL = "\u2588"  // full block

// Inline pixel art for the idle frame (16x16)
// Each row is 16 pixels
const SPRITES: Record<string, number[][]> = {
  idle: [
    [0,0,0,0,0,0,0,2,2,0,0,0,0,0,0,0],
    [0,0,0,0,0,0,0,3,3,0,0,0,0,0,0,0],
    [0,0,0,0,0,0,0,3,3,0,0,0,0,0,0,0],
    [0,0,0,0,0,1,1,1,1,1,1,0,0,0,0,0],
    [0,0,0,0,1,1,1,1,1,1,1,1,0,0,0,0],
    [0,0,0,0,1,2,2,1,1,2,2,1,0,0,0,0],
    [0,0,0,0,1,2,2,1,1,2,2,1,0,0,0,0],
    [0,0,0,0,1,1,1,1,1,1,1,1,0,0,0,0],
    [0,0,0,0,1,1,1,1,1,1,1,1,0,0,0,0],
    [0,0,0,0,2,2,2,2,2,2,2,2,0,0,0,0],
    [0,0,1,1,1,1,1,1,1,1,1,1,1,1,0,0],
    [0,0,3,3,1,1,1,1,1,1,1,1,3,3,0,0],
    [0,0,0,0,1,1,1,1,1,1,1,1,0,0,0,0],
    [0,0,0,0,1,1,0,0,0,0,1,1,0,0,0,0],
    [0,0,0,0,2,2,0,0,0,0,2,2,0,0,0,0],
    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
  ],
  "walk-right": [
    [0,0,0,0,0,0,0,2,2,0,0,0,0,0,0,0],
    [0,0,0,0,0,0,0,3,3,0,0,0,0,0,0,0],
    [0,0,0,0,0,0,0,3,3,0,0,0,0,0,0,0],
    [0,0,0,0,0,1,1,1,1,1,1,0,0,0,0,0],
    [0,0,0,0,1,1,1,1,1,1,1,1,0,0,0,0],
    [0,0,0,0,1,2,2,1,1,2,2,1,0,0,0,0],
    [0,0,0,0,1,2,2,1,1,2,2,1,0,0,0,0],
    [0,0,0,0,1,1,1,1,1,1,1,1,0,0,0,0],
    [0,0,0,0,1,1,1,1,1,1,1,1,0,0,0,0],
    [0,0,0,0,2,2,2,2,2,2,2,2,0,0,0,0],
    [0,0,1,1,1,1,1,1,1,1,1,1,1,1,0,0],
    [0,0,3,3,1,1,1,1,1,1,1,1,3,3,0,0],
    [0,0,0,0,1,1,1,1,1,1,1,1,0,0,0,0],
    [0,0,0,0,0,1,1,0,0,1,1,0,0,0,0,0],
    [0,0,0,0,0,2,2,0,2,2,0,0,0,0,0,0],
    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
  ],
  "walk-left": [
    [0,0,0,0,0,0,0,2,2,0,0,0,0,0,0,0],
    [0,0,0,0,0,0,0,3,3,0,0,0,0,0,0,0],
    [0,0,0,0,0,0,0,3,3,0,0,0,0,0,0,0],
    [0,0,0,0,0,1,1,1,1,1,1,0,0,0,0,0],
    [0,0,0,0,1,1,1,1,1,1,1,1,0,0,0,0],
    [0,0,0,0,1,2,2,1,1,2,2,1,0,0,0,0],
    [0,0,0,0,1,2,2,1,1,2,2,1,0,0,0,0],
    [0,0,0,0,1,1,1,1,1,1,1,1,0,0,0,0],
    [0,0,0,0,1,1,1,1,1,1,1,1,0,0,0,0],
    [0,0,0,0,2,2,2,2,2,2,2,2,0,0,0,0],
    [0,0,1,1,1,1,1,1,1,1,1,1,1,1,0,0],
    [0,0,3,3,1,1,1,1,1,1,1,1,3,3,0,0],
    [0,0,0,0,1,1,1,1,1,1,1,1,0,0,0,0],
    [0,0,0,0,0,1,1,0,0,1,1,0,0,0,0,0],
    [0,0,0,0,2,2,0,0,0,0,2,2,0,0,0,0],
    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
  ],
  think: [
    [0,0,0,0,0,0,0,2,2,0,0,0,0,0,0,0],
    [0,0,0,0,0,0,0,3,3,0,0,0,0,0,0,0],
    [0,0,0,0,0,0,0,3,3,0,0,0,0,0,0,0],
    [0,0,0,0,0,1,1,1,1,1,1,0,0,0,0,0],
    [0,0,0,0,1,2,2,1,1,2,2,1,0,0,0,0],
    [0,0,0,0,1,2,2,1,1,2,2,1,0,0,0,0],
    [0,0,0,0,1,1,1,1,1,1,1,1,0,0,0,0],
    [0,0,0,0,1,1,1,1,1,1,1,1,0,0,0,0],
    [0,0,0,0,1,1,1,1,1,1,1,1,0,0,0,0],
    [0,0,0,0,2,2,2,2,2,2,2,2,0,0,0,0],
    [0,0,1,1,1,1,1,1,1,1,1,1,1,1,0,0],
    [0,0,3,3,1,1,1,1,1,1,1,1,3,3,0,0],
    [0,0,0,0,1,1,1,1,1,1,1,1,0,0,0,0],
    [0,0,0,0,1,1,0,0,0,0,1,1,0,0,0,0],
    [0,0,0,0,2,2,0,0,0,0,2,2,0,0,0,0],
    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
  ],
  sleep: [
    [0,0,0,0,0,0,0,2,2,0,0,0,0,0,0,0],
    [0,0,0,0,0,0,0,3,3,0,0,0,0,3,0,0],
    [0,0,0,0,0,0,0,3,3,0,0,0,3,0,0,0],
    [0,0,0,0,0,1,1,1,1,1,1,0,0,3,0,0],
    [0,0,0,0,1,1,1,1,1,1,1,1,0,0,0,0],
    [0,0,0,0,1,3,3,1,1,3,3,1,0,0,0,0],
    [0,0,0,0,1,1,1,1,1,1,1,1,0,0,0,0],
    [0,0,0,0,1,1,1,1,1,1,1,1,0,0,0,0],
    [0,0,0,0,1,1,1,1,1,1,1,1,0,0,0,0],
    [0,0,0,0,2,2,2,2,2,2,2,2,0,0,0,0],
    [0,0,1,1,1,1,1,1,1,1,1,1,1,1,0,0],
    [0,0,3,3,1,1,1,1,1,1,1,1,3,3,0,0],
    [0,0,0,0,1,1,1,0,0,1,1,1,0,0,0,0],
    [0,0,0,0,2,2,2,0,0,2,2,2,0,0,0,0],
    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
  ],
}

// MARK: - ANSI Sprite Renderer

export function renderSpriteToAnsi(sprite: number[][]): string {
  const lines: string[] = []

  // Render using half-block characters (2 pixel rows per terminal row)
  for (let y = 0; y < sprite.length; y += 2) {
    let line = ""
    const topRow = sprite[y] || []
    const bottomRow = sprite[y + 1] || []

    for (let x = 0; x < 16; x++) {
      const top = topRow[x] || 0
      const bottom = bottomRow[x] || 0

      if (top === 0 && bottom === 0) {
        line += " " // both transparent
      } else if (top === 0 && bottom !== 0) {
        line += (PALETTE[bottom] || "") + BLOCK_LOWER + RESET
      } else if (top !== 0 && bottom === 0) {
        line += (PALETTE[top] || "") + BLOCK_UPPER + RESET
      } else if (top === bottom) {
        line += (PALETTE[top] || "") + BLOCK_FULL + RESET
      } else {
        // Different colors: use upper half block with fg=top, bg=bottom
        const fg = PALETTE[top] || ""
        const bgColor = top === 1 ? "48;2;26;26;46" : top === 2 ? "48;2;232;97;10" : top === 3 ? "48;2;255;140;66" : "48;2;232;97;10"
        const fgTop = PALETTE[top] || ""
        const bgBottom = bottom === 1 ? "\x1b[48;2;26;26;46m" : bottom === 2 ? "\x1b[48;2;232;97;10m" : bottom === 3 ? "\x1b[48;2;255;140;66m" : "\x1b[48;2;232;97;10m"
        line += fgTop + bgBottom + BLOCK_UPPER + RESET
      }
    }
    lines.push(line)
  }

  return lines.join("\n")
}

// MARK: - Terminal Pet Controller

type PetState = "idle" | "walk-right" | "walk-left" | "think" | "sleep"

export class TerminalPet {
  private state: PetState = "idle"
  private posX: number = 0
  private maxX: number = 60
  private direction: number = 1
  private frameIndex: number = 0
  private animTimer: ReturnType<typeof setInterval> | null = null
  private idleTimer: ReturnType<typeof setInterval> | null = null
  private idleSeconds: number = 0
  private label: string = "eight"
  private visible: boolean = true

  // Callbacks
  onRender?: (lines: string[], x: number, label: string) => void

  constructor(opts?: { label?: string; maxWidth?: number }) {
    this.label = opts?.label || "eight"
    this.maxX = (opts?.maxWidth || process.stdout.columns || 80) - 18
  }

  start() {
    this.animTimer = setInterval(() => this.tick(), 200)
    this.idleTimer = setInterval(() => {
      this.idleSeconds++
      if (this.idleSeconds > 120 && this.state !== "sleep") {
        this.setState("sleep")
      } else if (this.idleSeconds > 60 && this.state === "idle") {
        this.setState("sleep")
      }
    }, 1000)
    this.scheduleRandomAction()
  }

  stop() {
    if (this.animTimer) clearInterval(this.animTimer)
    if (this.idleTimer) clearInterval(this.idleTimer)
  }

  setState(state: PetState) {
    this.state = state
    this.frameIndex = 0
    this.idleSeconds = 0
  }

  setLabel(label: string) {
    this.label = label
  }

  // Called by external events (daemon, agent mesh)
  onEvent(event: string) {
    this.idleSeconds = 0
    switch (event) {
      case "thinking": this.setState("think"); this.label = "thinking..."; break
      case "tool:start": this.setState("walk-right"); this.label = "working..."; break
      case "done": this.setState("idle"); this.label = "done!"; break
      case "error": this.setState("idle"); this.label = "error!"; break
      default: break
    }
  }

  private tick() {
    if (!this.visible) return

    const sprite = SPRITES[this.state] || SPRITES.idle
    const rendered = renderSpriteToAnsi(sprite)
    const lines = rendered.split("\n")

    // Movement
    if (this.state === "walk-right") {
      this.posX += 1
      if (this.posX >= this.maxX) {
        this.posX = this.maxX
        this.direction = -1
        this.state = "walk-left"
      }
    } else if (this.state === "walk-left") {
      this.posX -= 1
      if (this.posX <= 0) {
        this.posX = 0
        this.direction = 1
        this.state = "walk-right"
      }
    }

    this.onRender?.(lines, this.posX, this.label)
  }

  private scheduleRandomAction() {
    const delay = 4000 + Math.random() * 8000
    setTimeout(() => {
      if (this.state === "idle" && this.idleSeconds < 60) {
        this.setState(Math.random() > 0.5 ? "walk-right" : "walk-left")
      } else if (this.state === "walk-right" || this.state === "walk-left") {
        this.setState("idle")
      }
      this.scheduleRandomAction()
    }, delay)
  }

  // Render a single frame to string (for embedding in TUI)
  renderFrame(): { lines: string[]; x: number; label: string } {
    const sprite = SPRITES[this.state] || SPRITES.idle
    const rendered = renderSpriteToAnsi(sprite)
    return { lines: rendered.split("\n"), x: this.posX, label: this.label }
  }

  // Cross-platform TTS
  static speak(text: string) {
    const { spawn } = require("child_process")
    const platform = process.platform

    const cleaned = text.slice(0, 350).replace(/"/g, "'").replace(/`/g, "")

    if (platform === "darwin") {
      spawn("say", ["-v", "Ava", "-r", "190", cleaned], { stdio: "ignore" })
    } else if (platform === "linux") {
      // Try espeak, then spd-say, then festival
      const proc = spawn("espeak", [cleaned], { stdio: "ignore" })
      proc.on("error", () => {
        spawn("spd-say", [cleaned], { stdio: "ignore" }).on("error", () => {
          // No TTS available - silent
        })
      })
    } else if (platform === "win32") {
      // PowerShell TTS
      spawn("powershell", ["-Command", `Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).Speak('${cleaned}')`], { stdio: "ignore" })
    }
  }
}

// MARK: - Standalone mode (run directly)

if (import.meta.main) {
  console.log("\x1b[36mLil Eight - Terminal Mode\x1b[0m\n")

  const pet = new TerminalPet()

  // Simple terminal renderer - draws at bottom of screen
  const rows = process.stdout.rows || 24
  const petHeight = 8 // 16px / 2 = 8 terminal rows

  pet.onRender = (lines, x, label) => {
    // Save cursor, move to bottom area, draw, restore
    const startRow = rows - petHeight - 1
    const padding = " ".repeat(Math.max(0, x))

    process.stdout.write("\x1b[s") // save cursor
    for (let i = 0; i < lines.length; i++) {
      process.stdout.write(`\x1b[${startRow + i};1H\x1b[2K${padding}${lines[i]}`)
    }
    // Label below
    const labelPad = " ".repeat(Math.max(0, x + 4))
    process.stdout.write(`\x1b[${startRow + lines.length};1H\x1b[2K${labelPad}\x1b[2m${label}\x1b[0m`)
    process.stdout.write("\x1b[u") // restore cursor
  }

  pet.start()

  // Keep alive
  process.stdin.resume()
  process.on("SIGINT", () => {
    pet.stop()
    // Clear pet area
    const startRow = rows - petHeight - 1
    for (let i = 0; i <= petHeight + 1; i++) {
      process.stdout.write(`\x1b[${startRow + i};1H\x1b[2K`)
    }
    process.exit(0)
  })

  console.log("Lil Eight is walking... (Ctrl+C to quit)")
}
