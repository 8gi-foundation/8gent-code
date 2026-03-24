/**
 * Sprite Generator for Lil Eight
 * Generates walk cycle sprite sheets using Canvas API
 *
 * Output: 64x64 frames in a horizontal strip PNG
 * States: idle (4), walk-right (6), walk-left (6), think (4), success (4), error (4), sleep (6), wave (4), sit (4), celebrate (6), drag (2), typing (4)
 *
 * Run: bun run apps/lil-eight/generate-sprites.ts
 */

import { createCanvas } from "@napi-rs/canvas"
import { writeFileSync, mkdirSync } from "fs"
import { join } from "path"

const FRAME_SIZE = 64
const SCALE = 1 // internal pixel scale (1 = true pixel art)
const BRAND_ORANGE = "#E8610A"
const BODY_COLOR = "#1A1A2E"  // dark navy body
const EYE_COLOR = "#E8610A"   // orange eyes
const ACCENT = "#FF8C42"      // lighter orange for highlights

interface SpriteState {
  name: string
  frames: number
  draw: (ctx: CanvasRenderingContext2D, frame: number) => void
}

// Helper: draw a pixel-art rectangle
function px(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, color: string) {
  ctx.fillStyle = color
  ctx.fillRect(x * 4, y * 4, w * 4, h * 4) // 4x scale for 16px grid -> 64px
}

// The 8gent character: a small robot/figure with the "8" shape
function drawBody(ctx: CanvasRenderingContext2D, offsetY: number, legOffset: number, armAngle: number) {
  // Shadow
  px(ctx, 4, 15 + Math.round(offsetY / 4), 8, 1, "rgba(0,0,0,0.2)")

  // Legs (animated)
  const leftLegX = 5 + legOffset
  const rightLegX = 9 - legOffset
  px(ctx, leftLegX, 13, 2, 2 + Math.abs(legOffset), BODY_COLOR)
  px(ctx, rightLegX, 13, 2, 2 - Math.abs(legOffset), BODY_COLOR)

  // Feet
  px(ctx, leftLegX - (legOffset > 0 ? 1 : 0), 14 + Math.abs(legOffset), 3, 1, BRAND_ORANGE)
  px(ctx, rightLegX - (legOffset < 0 ? 1 : 0), 14 - Math.abs(legOffset), 3, 1, BRAND_ORANGE)

  // Lower body (bottom of the "8")
  px(ctx, 4, 10, 8, 4, BODY_COLOR)
  px(ctx, 5, 9, 6, 1, BODY_COLOR)

  // Waist (narrow part of "8")
  px(ctx, 5, 8, 6, 2, BODY_COLOR)

  // Upper body (top of the "8")
  px(ctx, 4, 4, 8, 5, BODY_COLOR)
  px(ctx, 5, 3, 6, 1, BODY_COLOR)

  // Arms
  const armY = 6 + Math.round(armAngle)
  px(ctx, 2, armY, 2, 3, BODY_COLOR)      // left arm
  px(ctx, 12, armY, 2, 3, BODY_COLOR)     // right arm
  px(ctx, 2, armY + 3, 2, 1, ACCENT)      // left hand
  px(ctx, 12, armY + 3, 2, 1, ACCENT)     // right hand

  // Face - "8" visor/eyes
  px(ctx, 5, 5, 2, 2, EYE_COLOR)   // left eye
  px(ctx, 9, 5, 2, 2, EYE_COLOR)   // right eye

  // Antenna
  px(ctx, 7, 1, 2, 2, ACCENT)
  px(ctx, 7, 0, 2, 1, BRAND_ORANGE)

  // Belt accent
  px(ctx, 4, 9, 8, 1, BRAND_ORANGE)
}

function drawThinkBubble(ctx: CanvasRenderingContext2D, frame: number) {
  const dots = (frame % 4) + 1
  // Small thought dots
  px(ctx, 13, 3, 1, 1, "#FFFFFF")
  if (dots > 1) px(ctx, 14, 2, 1, 1, "#FFFFFF")
  if (dots > 2) px(ctx, 15, 1, 1, 1, "#FFFFFF")
}

function drawZzz(ctx: CanvasRenderingContext2D, frame: number) {
  const zColors = ["#AAAAFF", "#8888DD", "#6666BB"]
  // Z's appear one by one, floating upward
  if (frame >= 1) px(ctx, 12, 5, 1, 1, zColors[0])
  if (frame >= 2) {
    px(ctx, 12, 5, 1, 1, zColors[0])
    px(ctx, 13, 3, 1, 1, zColors[1])
  }
  if (frame >= 3) {
    px(ctx, 12, 5, 1, 1, zColors[0])
    px(ctx, 13, 3, 1, 1, zColors[1])
    px(ctx, 14, 1, 1, 1, zColors[2])
  }
  if (frame >= 4) {
    px(ctx, 13, 3, 1, 1, zColors[1])
    px(ctx, 14, 1, 1, 1, zColors[2])
    px(ctx, 15, 0, 1, 1, zColors[0])
  }
  if (frame >= 5) {
    px(ctx, 14, 1, 1, 1, zColors[2])
    px(ctx, 15, 0, 1, 1, zColors[0])
  }
}

function drawSittingBody(ctx: CanvasRenderingContext2D, offsetY: number) {
  // Shadow (wider since sitting)
  px(ctx, 3, 15, 10, 1, "rgba(0,0,0,0.2)")

  // Legs tucked under - horizontal on ground
  px(ctx, 4, 13, 3, 1, BODY_COLOR) // left leg tucked
  px(ctx, 9, 13, 3, 1, BODY_COLOR) // right leg tucked
  px(ctx, 4, 14, 3, 1, BRAND_ORANGE) // left foot
  px(ctx, 9, 14, 3, 1, BRAND_ORANGE) // right foot

  // Lower body (bottom of "8") - shifted down since sitting
  px(ctx, 4, 10, 8, 4, BODY_COLOR)
  px(ctx, 5, 9, 6, 1, BODY_COLOR)

  // Waist
  px(ctx, 5, 8, 6, 2, BODY_COLOR)

  // Upper body (top of "8")
  const bobY = Math.round(offsetY)
  px(ctx, 4, 4 + bobY, 8, 5, BODY_COLOR)
  px(ctx, 5, 3 + bobY, 6, 1, BODY_COLOR)

  // Arms resting on sides
  px(ctx, 2, 8, 2, 3, BODY_COLOR)
  px(ctx, 12, 8, 2, 3, BODY_COLOR)
  px(ctx, 2, 11, 2, 1, ACCENT)
  px(ctx, 12, 11, 2, 1, ACCENT)

  // Face
  px(ctx, 5, 5 + bobY, 2, 2, EYE_COLOR)
  px(ctx, 9, 5 + bobY, 2, 2, EYE_COLOR)

  // Antenna
  px(ctx, 7, 1 + bobY, 2, 2, ACCENT)
  px(ctx, 7, 0 + bobY, 2, 1, BRAND_ORANGE)

  // Belt
  px(ctx, 4, 9, 8, 1, BRAND_ORANGE)
}

function drawConfetti(ctx: CanvasRenderingContext2D, frame: number) {
  const colors = [BRAND_ORANGE, ACCENT, "#FFD700", "#00FF88", "#FF6B6B", "#55BBFF"]
  const seed = frame * 7
  for (let i = 0; i < 8; i++) {
    const x = ((seed + i * 31) % 14) + 1
    const y = ((seed + i * 17) % 10) + frame
    if (y >= 0 && y < 16 && x >= 0 && x < 16) {
      px(ctx, x, y, 1, 1, colors[i % colors.length])
    }
  }
}

function drawCodeParticles(ctx: CanvasRenderingContext2D, frame: number) {
  const chars = ["#00FF88", "#55BBFF", ACCENT]
  // Small particles emanating from typing area
  for (let i = 0; i < 3; i++) {
    const x = 6 + ((frame + i * 3) % 5)
    const y = 10 - ((frame + i * 2) % 4)
    if (y >= 0 && y < 16) {
      px(ctx, x, y, 1, 1, chars[i % chars.length])
    }
  }
}

function drawSuccessParticles(ctx: CanvasRenderingContext2D, frame: number) {
  const spread = frame * 0.5
  const colors = [BRAND_ORANGE, ACCENT, "#FFD700", "#00FF88"]
  for (let i = 0; i < 4; i++) {
    const angle = (i * Math.PI / 2) + (frame * 0.3)
    const x = 8 + Math.cos(angle) * (2 + spread)
    const y = 4 + Math.sin(angle) * (2 + spread)
    if (x >= 0 && x < 16 && y >= 0 && y < 16) {
      px(ctx, Math.round(x), Math.round(y), 1, 1, colors[i])
    }
  }
}

const states: SpriteState[] = [
  {
    name: "idle",
    frames: 4,
    draw(ctx, frame) {
      // Gentle breathing bob
      const bob = Math.sin(frame * Math.PI / 2) * 0.3
      drawBody(ctx, bob, 0, Math.sin(frame * Math.PI / 2) * 0.2)
      // Blink on frame 3
      if (frame === 3) {
        px(ctx, 5, 5, 2, 1, BODY_COLOR) // close left eye
        px(ctx, 9, 5, 2, 1, BODY_COLOR) // close right eye
      }
    }
  },
  {
    name: "walk-right",
    frames: 6,
    draw(ctx, frame) {
      const legCycle = Math.sin(frame * Math.PI / 3) * 1
      const bob = Math.abs(Math.sin(frame * Math.PI / 3)) * 0.5
      const armSwing = Math.sin(frame * Math.PI / 3) * 0.5
      drawBody(ctx, -bob, Math.round(legCycle), armSwing)
    }
  },
  {
    name: "walk-left",
    frames: 6,
    draw(ctx, frame) {
      // Mirror of walk-right
      const legCycle = Math.sin(frame * Math.PI / 3) * 1
      const bob = Math.abs(Math.sin(frame * Math.PI / 3)) * 0.5
      const armSwing = -Math.sin(frame * Math.PI / 3) * 0.5
      drawBody(ctx, -bob, -Math.round(legCycle), armSwing)
    }
  },
  {
    name: "think",
    frames: 4,
    draw(ctx, frame) {
      drawBody(ctx, 0, 0, -0.5) // arms slightly raised
      drawThinkBubble(ctx, frame)
      // Eyes look up
      px(ctx, 5, 4, 2, 2, EYE_COLOR)
      px(ctx, 9, 4, 2, 2, EYE_COLOR)
    }
  },
  {
    name: "success",
    frames: 4,
    draw(ctx, frame) {
      // Jump animation
      const jumpHeight = Math.sin(frame * Math.PI / 4) * 2
      drawBody(ctx, -jumpHeight, 0, -1) // arms up
      drawSuccessParticles(ctx, frame)
    }
  },
  {
    name: "error",
    frames: 4,
    draw(ctx, frame) {
      // Shake animation
      const shake = (frame % 2 === 0) ? 0.5 : -0.5
      ctx.save()
      ctx.translate(shake * 4, 0)
      drawBody(ctx, 0, 0, 0.5) // arms droopy
      ctx.restore()
      // X eyes
      px(ctx, 5, 5, 1, 1, "#FF0000")
      px(ctx, 6, 6, 1, 1, "#FF0000")
      px(ctx, 6, 5, 1, 1, "#FF0000")
      px(ctx, 5, 6, 1, 1, "#FF0000")
      px(ctx, 9, 5, 1, 1, "#FF0000")
      px(ctx, 10, 6, 1, 1, "#FF0000")
      px(ctx, 10, 5, 1, 1, "#FF0000")
      px(ctx, 9, 6, 1, 1, "#FF0000")
    }
  },
  {
    name: "sleep",
    frames: 6,
    draw(ctx, frame) {
      // Body slightly compressed/slouched - sitting posture
      drawSittingBody(ctx, Math.sin(frame * Math.PI / 3) * 0.2)
      // Closed eyes (sleeping)
      px(ctx, 5, 6, 2, 1, ACCENT)
      px(ctx, 9, 6, 2, 1, ACCENT)
      // Zzz floating above
      drawZzz(ctx, frame)
    }
  },
  {
    name: "wave",
    frames: 4,
    draw(ctx, frame) {
      // Standing body, normal pose
      drawBody(ctx, 0, 0, 0)
      // Override right arm - raised and waving side to side
      const waveX = 12 + Math.round(Math.sin(frame * Math.PI / 2) * 1)
      px(ctx, 12, 6, 2, 3, BODY_COLOR) // clear default right arm area
      px(ctx, waveX, 2, 2, 2, BODY_COLOR)  // upper arm raised
      px(ctx, waveX, 4, 2, 1, BODY_COLOR)  // forearm
      px(ctx, waveX, 1, 2, 1, ACCENT)      // hand waving up high
    }
  },
  {
    name: "sit",
    frames: 4,
    draw(ctx, frame) {
      // Gentle breathing bob while sitting
      const bob = Math.sin(frame * Math.PI / 2) * 0.3
      drawSittingBody(ctx, bob)
      // Relaxed half-closed eyes on some frames
      if (frame === 2 || frame === 3) {
        px(ctx, 5, 5, 2, 1, BODY_COLOR) // half-close left eye
        px(ctx, 9, 5, 2, 1, BODY_COLOR) // half-close right eye
      }
    }
  },
  {
    name: "celebrate",
    frames: 6,
    draw(ctx, frame) {
      // Big jump - more dramatic than success
      const jumpHeight = Math.sin(frame * Math.PI / 6) * 4
      drawBody(ctx, -jumpHeight, 0, -1.5) // arms way up
      // Override arms to be fully extended upward
      const armY = 2 - Math.round(jumpHeight / 2)
      if (armY >= 0) {
        px(ctx, 2, armY, 2, 2, BODY_COLOR)
        px(ctx, 12, armY, 2, 2, BODY_COLOR)
        px(ctx, 2, armY - 1 < 0 ? 0 : armY - 1, 2, 1, ACCENT)
        px(ctx, 12, armY - 1 < 0 ? 0 : armY - 1, 2, 1, ACCENT)
      }
      // Confetti raining down
      drawConfetti(ctx, frame)
    }
  },
  {
    name: "drag",
    frames: 2,
    draw(ctx, frame) {
      // Surprised/alarmed pose
      const tilt = frame === 0 ? 0.5 : -0.5
      ctx.save()
      ctx.translate(tilt * 4, 0)
      drawBody(ctx, 0, 0, -0.8) // arms out to sides
      ctx.restore()
      // Wide eyes (larger than normal)
      px(ctx, 4, 4, 3, 3, EYE_COLOR)  // left eye wide
      px(ctx, 9, 4, 3, 3, EYE_COLOR)  // right eye wide
      // Pupils (small dots for alarmed look)
      px(ctx, 5, 5, 1, 1, "#FFFFFF")
      px(ctx, 10, 5, 1, 1, "#FFFFFF")
    }
  },
  {
    name: "typing",
    frames: 4,
    draw(ctx, frame) {
      // Standing body, slight forward lean
      drawBody(ctx, 0.3, 0, 0.3)
      // Override arms - rapid typing motion in front of body
      const leftArmX = 4 + (frame % 2)
      const rightArmX = 10 - (frame % 2)
      const armBob = (frame % 2 === 0) ? 0 : 1
      // Arms in front, typing position
      px(ctx, leftArmX, 9 + armBob, 2, 2, BODY_COLOR)
      px(ctx, rightArmX, 9 - armBob, 2, 2, BODY_COLOR)
      px(ctx, leftArmX, 11 + armBob, 2, 1, ACCENT) // left hand
      px(ctx, rightArmX, 11 - armBob, 2, 1, ACCENT) // right hand
      // Code particles emanating
      drawCodeParticles(ctx, frame)
    }
  }
]

const outDir = join(import.meta.dir, "sprites")
mkdirSync(outDir, { recursive: true })

// Generate each state as a horizontal sprite strip
for (const state of states) {
  const width = FRAME_SIZE * state.frames
  const height = FRAME_SIZE
  const canvas = createCanvas(width, height)
  const ctx = canvas.getContext("2d")

  for (let f = 0; f < state.frames; f++) {
    ctx.save()
    ctx.translate(f * FRAME_SIZE, 0)
    state.draw(ctx, f)
    ctx.restore()
  }

  const buffer = canvas.toBuffer("image/png")
  const outPath = join(outDir, `${state.name}.png`)
  writeFileSync(outPath, buffer)
  console.log(`Generated: ${state.name}.png (${state.frames} frames, ${width}x${height})`)
}

// Also generate a combined sprite atlas
const totalFrames = states.reduce((sum, s) => sum + s.frames, 0)
const atlasCanvas = createCanvas(FRAME_SIZE * totalFrames, FRAME_SIZE)
const atlasCtx = atlasCanvas.getContext("2d")

let offset = 0
const manifest: Record<string, { start: number; count: number }> = {}

for (const state of states) {
  manifest[state.name] = { start: offset, count: state.frames }
  for (let f = 0; f < state.frames; f++) {
    atlasCtx.save()
    atlasCtx.translate((offset + f) * FRAME_SIZE, 0)
    state.draw(atlasCtx, f)
    atlasCtx.restore()
  }
  offset += state.frames
}

writeFileSync(join(outDir, "atlas.png"), atlasCanvas.toBuffer("image/png"))
writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2))
console.log(`\nAtlas: ${totalFrames} frames total`)
console.log("Manifest:", JSON.stringify(manifest, null, 2))
