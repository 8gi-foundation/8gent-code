/**
 * Sprite Generation Prompt Templates
 *
 * Pre-built prompts for AI image generators (ChatGPT Image, DALL-E, Midjourney).
 * Each prompt is tuned to produce sprite sheets that slice cleanly.
 */

// ── Types ───────────────────────────────────────────────────────

export interface SpritePromptConfig {
  /** What to generate (e.g., "warrior character", "forest tileset") */
  subject: string;
  /** Art style */
  style?: "pixel-art" | "hand-drawn" | "3d-render" | "anime" | "painterly";
  /** Grid dimensions */
  cols?: number;
  rows?: number;
  /** Frame size in pixels */
  frameSize?: number;
  /** Background type */
  background?: "transparent" | "solid-color" | "none";
  /** Animation type (for character sprites) */
  animation?: "idle" | "walk" | "run" | "attack" | "jump" | "all";
  /** View angle */
  view?: "side" | "top-down" | "isometric" | "front";
}

// ── Prompt Templates ────────────────────────────────────────────

export const SPRITE_PROMPTS = {
  /** Character sprite sheet - walk cycle, idle, attack */
  character: (cfg: SpritePromptConfig) => {
    const style = cfg.style || "pixel-art";
    const cols = cfg.cols || 8;
    const rows = cfg.rows || 4;
    const size = cfg.frameSize || 64;
    const view = cfg.view || "side";
    const bg = cfg.background === "solid-color" ? "solid flat color background" : "transparent background";

    return `Create a ${style} sprite sheet for a ${cfg.subject}. ${view}-view perspective.
Grid layout: ${cols} columns x ${rows} rows. Each frame is ${size}x${size} pixels.
Row 1: Idle animation (${cols} frames, subtle breathing/movement)
Row 2: Walk cycle (${cols} frames, smooth loop)
Row 3: Run cycle (${cols} frames, faster motion)
Row 4: Attack animation (${cols} frames, wind-up to strike)
${bg}. Clean edges, consistent proportions across all frames. No overlap between frames. Perfect grid alignment.`;
  },

  /** Tileset for level building */
  tileset: (cfg: SpritePromptConfig) => {
    const style = cfg.style || "pixel-art";
    const size = cfg.frameSize || 32;
    const view = cfg.view || "top-down";

    return `Create a ${style} tileset sprite sheet for a ${cfg.subject} environment. ${view} perspective.
Grid layout: 8 columns x 8 rows. Each tile is ${size}x${size} pixels.
Include: ground/floor variants (4+), walls (top, bottom, left, right, corners), decorative objects, interactive elements (doors, chests, switches), hazards, path/road tiles.
All tiles must connect seamlessly when placed adjacent. Consistent lighting from top-left. Transparent background where applicable. Perfect grid alignment, no overlap.`;
  },

  /** UI elements (buttons, frames, icons) */
  ui: (cfg: SpritePromptConfig) => {
    const style = cfg.style || "pixel-art";
    const size = cfg.frameSize || 48;

    return `Create a ${style} game UI sprite sheet for ${cfg.subject}.
Grid layout: 6 columns x 4 rows. Each element is ${size}x${size} pixels.
Row 1: Buttons (normal, hover, pressed, disabled, toggle-on, toggle-off)
Row 2: Frames/panels (dialog box corners and edges for 9-slice)
Row 3: Icons (heart, coin, star, gem, key, shield)
Row 4: Bars (health bar segments, mana bar segments, XP bar)
Transparent background. Clean anti-aliased edges. Consistent style across all elements.`;
  },

  /** Items and collectibles */
  items: (cfg: SpritePromptConfig) => {
    const style = cfg.style || "pixel-art";
    const size = cfg.frameSize || 32;

    return `Create a ${style} item sprite sheet for ${cfg.subject}.
Grid layout: 8 columns x 4 rows. Each item is ${size}x${size} pixels.
Row 1: Weapons (sword, axe, bow, staff, dagger, hammer, spear, wand)
Row 2: Potions and consumables (health, mana, speed, shield, fire, ice, poison, antidote)
Row 3: Materials and loot (gold coin, gem, crystal, ore, wood, herb, feather, bone)
Row 4: Equipment (helmet, armor, boots, gloves, ring, amulet, cape, belt)
Transparent background. Each item centered in its cell. Consistent lighting and style.`;
  },

  /** Particle effects */
  particles: (cfg: SpritePromptConfig) => {
    const style = cfg.style || "pixel-art";
    const cols = cfg.cols || 8;

    return `Create a ${style} particle effect sprite sheet for ${cfg.subject}.
Grid layout: ${cols} columns x 4 rows. Each frame is 64x64 pixels.
Row 1: Explosion sequence (${cols} frames, expanding to dissipating)
Row 2: Smoke/dust puff (${cols} frames, expanding then fading)
Row 3: Magic sparkle/glow (${cols} frames, appearing and twinkling)
Row 4: Hit impact (${cols} frames, sharp flash then rings)
Transparent background. Bright, vibrant colors. Each row is a complete animation loop.`;
  },
};

// ── Builder ─────────────────────────────────────────────────────

/**
 * Build a sprite generation prompt from config.
 * Automatically selects the right template based on context.
 */
export function buildSpritePrompt(config: SpritePromptConfig): string {
  const subject = config.subject.toLowerCase();

  // Auto-detect template from subject
  if (subject.includes("tile") || subject.includes("terrain") || subject.includes("environment")) {
    return SPRITE_PROMPTS.tileset(config);
  }
  if (subject.includes("ui") || subject.includes("button") || subject.includes("interface")) {
    return SPRITE_PROMPTS.ui(config);
  }
  if (subject.includes("item") || subject.includes("weapon") || subject.includes("loot")) {
    return SPRITE_PROMPTS.items(config);
  }
  if (subject.includes("particle") || subject.includes("effect") || subject.includes("explosion")) {
    return SPRITE_PROMPTS.particles(config);
  }

  // Default to character sprite
  return SPRITE_PROMPTS.character(config);
}
