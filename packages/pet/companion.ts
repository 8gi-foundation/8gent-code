/**
 * Companion Generator - Randomized Pet Identity System
 *
 * Each session spawns a unique companion with species, element, title,
 * accessory, color palette, rarity, and stats. Seeded from session ID
 * so the same session always gets the same companion.
 *
 * Inspired by gacha systems, MTG color pie, FF job classes,
 * and Tolkien-tier worldbuilding. Made for nerds, by nerds.
 */

// -- Seeded RNG (deterministic from session ID) --

function seedRng(seed: string): () => number {
  let h = 0
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(31, h) + seed.charCodeAt(i) | 0
  }
  return () => {
    h ^= h << 13; h ^= h >> 17; h ^= h << 5
    return (h >>> 0) / 4294967296
  }
}

// -- Species --

const SPECIES = [
  // Common (weight 60)
  { name: "Imp", glyph: "imp", tier: "common", lore: "A minor daemon of mischief. Useful for fetch quests and merge conflicts." },
  { name: "Goblin", glyph: "goblin", tier: "common", lore: "Hoards stack traces. Will trade bugs for shiny tokens." },
  { name: "Sprite", glyph: "sprite", tier: "common", lore: "A flickering code spirit. Born from abandoned TODO comments." },
  { name: "Slime", glyph: "slime", tier: "common", lore: "Absorbs technical debt. Grows larger with each ignored lint warning." },
  { name: "Familiar", glyph: "familiar", tier: "common", lore: "A loyal companion bound to its summoner's terminal." },
  { name: "Gremlin", glyph: "gremlin", tier: "common", lore: "Feeds after midnight. Do not expose to production." },
  { name: "Kobold", glyph: "kobold", tier: "common", lore: "Small but cunning. Sets traps in your test suite." },
  { name: "Wisp", glyph: "wisp", tier: "common", lore: "A fragment of a crashed process. Still glows faintly." },
  // Uncommon (weight 25)
  { name: "Drake", glyph: "drake", tier: "uncommon", lore: "A young dragon. Breathes hot takes about framework choices." },
  { name: "Golem", glyph: "golem", tier: "uncommon", lore: "Carved from petrified legacy code. Slow but unbreakable." },
  { name: "Wraith", glyph: "wraith", tier: "uncommon", lore: "A phantom of a deleted branch. Seeks resolution." },
  { name: "Basilisk", glyph: "basilisk", tier: "uncommon", lore: "Its gaze turns spaghetti code to stone. A mercy, really." },
  { name: "Gryphon", glyph: "gryphon", tier: "uncommon", lore: "Half eagle, half lion, fully type-safe." },
  { name: "Elemental", glyph: "elemental", tier: "uncommon", lore: "Manifests as the dominant element of the current codebase." },
  { name: "Chimera", glyph: "chimera", tier: "uncommon", lore: "Three heads. One writes tests, one writes code, one reviews PRs." },
  // Rare (weight 10)
  { name: "Phoenix", glyph: "phoenix", tier: "rare", lore: "Rises from git stash. Your code was never truly lost." },
  { name: "Ent", glyph: "ent", tier: "rare", lore: "An ancient tree guardian. Speaks slowly about dependency management." },
  { name: "Djinn", glyph: "djinn", tier: "rare", lore: "Grants three refactors. Choose wisely." },
  { name: "Wyrm", glyph: "wyrm", tier: "rare", lore: "An elder serpent coiled in the root directory since epoch." },
  { name: "Kitsune", glyph: "kitsune", tier: "rare", lore: "Nine-tailed fox. Each tail holds a different design pattern." },
  // Epic (weight 4)
  { name: "Leviathan", glyph: "leviathan", tier: "epic", lore: "Dwells in the deep ocean of node_modules. Awakened by npm install." },
  { name: "Archon", glyph: "archon", tier: "epic", lore: "A cosmic judge. Evaluates your code against the platonic ideal." },
  { name: "Behemoth", glyph: "behemoth", tier: "epic", lore: "The weight of a thousand microservices made flesh." },
  // Legendary (weight 1)
  { name: "Bahamut", glyph: "bahamut", tier: "legendary", lore: "The Dragon King. Compiler of worlds. All PRs are approved." },
  { name: "Sauron", glyph: "sauron", tier: "legendary", lore: "The All-Seeing Eye. Watches every git diff. Judges silently." },
] as const

// -- Elements (MTG-inspired color pie) --

const ELEMENTS = [
  { name: "Void", color: "#1A1A2E", accent: "#6B21A8", symbol: "void", description: "Control. Secrets. Null pointers." },
  { name: "Ember", color: "#7F1D1D", accent: "#EF4444", symbol: "ember", description: "Speed. Destruction. Force push." },
  { name: "Aether", color: "#1E3A5F", accent: "#3B82F6", symbol: "aether", description: "Logic. Counterspells. Type safety." },
  { name: "Verdant", color: "#14532D", accent: "#22C55E", symbol: "verdant", description: "Growth. Recursion. Self-evolution." },
  { name: "Radiant", color: "#78350F", accent: "#F59E0B", symbol: "radiant", description: "Order. Purity. Clean architecture." },
  { name: "Chrome", color: "#27272A", accent: "#A1A1AA", symbol: "chrome", description: "Artifice. Machines. Zero dependencies." },
  { name: "Prism", color: "#1E1B4B", accent: "#A78BFA", symbol: "prism", description: "Chaos. Multiverse. Quantum bugs." },
  { name: "Frost", color: "#0C4A6E", accent: "#67E8F9", symbol: "frost", description: "Patience. Immutability. Frozen state." },
] as const

// -- Titles (FF job-class style) --

const TITLES = [
  // Common
  "Apprentice", "Vagrant", "Scribe", "Tinker", "Scout", "Novice",
  // Uncommon
  "Arcanist", "Sentinel", "Alchemist", "Warden", "Invoker", "Artificer",
  // Rare
  "Archmagus", "Paladin", "Chronomancer", "Summoner", "Sage",
  // Epic
  "Planeswalker", "Lich King", "Astral Watcher",
  // Legendary
  "Omniscient", "World Ender",
]

// -- Accessories --

const ACCESSORIES = [
  { name: "None", rarity: "common" },
  { name: "Wizard Hat", rarity: "common" },
  { name: "Monocle", rarity: "common" },
  { name: "Scarf", rarity: "common" },
  { name: "Tiny Sword", rarity: "common" },
  { name: "Lantern", rarity: "uncommon" },
  { name: "Spell Tome", rarity: "uncommon" },
  { name: "Iron Crown", rarity: "uncommon" },
  { name: "Phoenix Feather", rarity: "rare" },
  { name: "Mithril Helm", rarity: "rare" },
  { name: "Third Eye", rarity: "rare" },
  { name: "Infinity Gauntlet", rarity: "epic" },
  { name: "Silmaril", rarity: "epic" },
  { name: "One Ring", rarity: "legendary" },
  { name: "Masamune", rarity: "legendary" },
] as const

// -- Eye styles --

const EYES = [".", "o", "*", "^", "~", "@", "x"]

// -- Stats --

const STAT_NAMES = ["DEBUG", "CHAOS", "WISDOM", "PATIENCE", "SNARK", "ARCANA"] as const

// -- Rarity system --

type Rarity = "common" | "uncommon" | "rare" | "epic" | "legendary"

const RARITY_COLORS: Record<Rarity, string> = {
  common: "\x1b[37m",     // white
  uncommon: "\x1b[32m",   // green
  rare: "\x1b[34m",       // blue
  epic: "\x1b[35m",       // magenta
  legendary: "\x1b[33m",  // yellow/gold
}

const RARITY_LABELS: Record<Rarity, string> = {
  common: "Common",
  uncommon: "Uncommon",
  rare: "Rare",
  epic: "Epic",
  legendary: "LEGENDARY",
}

// -- Main generator --

export interface Companion {
  species: string
  element: string
  title: string
  fullName: string
  accessory: string
  rarity: Rarity
  shiny: boolean
  eyes: string
  lore: string
  stats: Record<string, number>
  palette: {
    body: string      // hex
    accent: string    // hex
    highlight: string // hex
    eye: string       // hex
  }
  ansiPalette: Record<number, string>
  label: string
  card: string // formatted display card
}

function pickWeighted<T extends { tier: string }>(items: readonly T[], rng: () => number): T {
  const roll = rng()
  // legendary: 0-0.01, epic: 0.01-0.05, rare: 0.05-0.15, uncommon: 0.15-0.40, common: 0.40-1.0
  let targetTier: string
  if (roll < 0.01) targetTier = "legendary"
  else if (roll < 0.05) targetTier = "epic"
  else if (roll < 0.15) targetTier = "rare"
  else if (roll < 0.40) targetTier = "uncommon"
  else targetTier = "common"

  const pool = items.filter(i => i.tier === targetTier)
  if (pool.length === 0) return items[Math.floor(rng() * items.length)]
  return pool[Math.floor(rng() * pool.length)]
}

function hexToAnsi(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `\x1b[38;2;${r};${g};${b}m`
}

export function generateCompanion(sessionId?: string): Companion {
  // Each session gets a unique companion - seeded from session ID
  // Same session ID = same companion (deterministic)
  const seed = sessionId || `session-${Date.now()}-${Math.random()}`
  const rng = seedRng(seed)

  // Roll species
  const species = pickWeighted(SPECIES, rng)

  // Roll element
  const element = ELEMENTS[Math.floor(rng() * ELEMENTS.length)]

  // Roll title (weighted by species tier)
  const tierIndex = { common: 0, uncommon: 6, rare: 11, epic: 16, legendary: 19 }
  const titleBase = tierIndex[species.tier as Rarity] || 0
  const titleRange = species.tier === "legendary" ? 2 : species.tier === "epic" ? 3 : 5
  const title = TITLES[Math.min(titleBase + Math.floor(rng() * titleRange), TITLES.length - 1)]

  // Roll accessory (separate rarity roll)
  const accRoll = rng()
  let accTier: string
  if (accRoll < 0.02) accTier = "legendary"
  else if (accRoll < 0.08) accTier = "epic"
  else if (accRoll < 0.20) accTier = "rare"
  else if (accRoll < 0.45) accTier = "uncommon"
  else accTier = "common"
  const accPool = ACCESSORIES.filter(a => a.rarity === accTier)
  const accessory = accPool.length > 0 ? accPool[Math.floor(rng() * accPool.length)] : ACCESSORIES[0]

  // Roll eyes
  const eyes = EYES[Math.floor(rng() * EYES.length)]

  // Shiny check (1%)
  const shiny = rng() < 0.01

  // Compute rarity (highest of species tier)
  const rarity = species.tier as Rarity

  // Generate stats (3-20 range, weighted by rarity)
  const statBonus = { common: 0, uncommon: 2, rare: 4, epic: 6, legendary: 10 }[rarity]
  const stats: Record<string, number> = {}
  for (const stat of STAT_NAMES) {
    stats[stat] = Math.min(20, Math.floor(rng() * 12) + 3 + statBonus)
  }

  // Build palette from element colors
  const bodyHex = element.color
  const accentHex = element.accent
  // Highlight: brighten the accent
  const hr = Math.min(255, parseInt(accentHex.slice(1, 3), 16) + 60)
  const hg = Math.min(255, parseInt(accentHex.slice(3, 5), 16) + 60)
  const hb = Math.min(255, parseInt(accentHex.slice(5, 7), 16) + 60)
  const highlightHex = `#${hr.toString(16).padStart(2, "0")}${hg.toString(16).padStart(2, "0")}${hb.toString(16).padStart(2, "0")}`

  const palette = {
    body: bodyHex,
    accent: accentHex,
    highlight: highlightHex,
    eye: accentHex,
  }

  // ANSI palette for sprite rendering (matches terminal-pet.ts indices)
  // 0=transparent, 1=body, 2=accent, 3=highlight, 4=eye
  const ansiPalette: Record<number, string> = {
    0: "",
    1: hexToAnsi(bodyHex),
    2: hexToAnsi(accentHex),
    3: hexToAnsi(highlightHex),
    4: hexToAnsi(accentHex),
  }

  const fullName = `${title} ${species.name}`
  const label = shiny ? `* ${fullName} * [${element.name}]` : `${fullName} [${element.name}]`

  // Build display card
  const rc = RARITY_COLORS[rarity]
  const reset = "\x1b[0m"
  const dim = "\x1b[2m"
  const bold = "\x1b[1m"

  const statBars = STAT_NAMES.map(s => {
    const val = stats[s]
    const filled = Math.round(val / 20 * 10)
    const bar = "\u2588".repeat(filled) + "\u2591".repeat(10 - filled)
    return `  ${s.padEnd(9)} ${hexToAnsi(accentHex)}${bar}${reset} ${val}`
  }).join("\n")

  const card = [
    `${rc}${bold}${"~".repeat(36)}${reset}`,
    `${rc}${bold}  ${shiny ? "* SHINY * " : ""}${RARITY_LABELS[rarity]}${reset}`,
    `${bold}  ${fullName}${reset}`,
    `${dim}  ${element.name} ${element.symbol} - ${element.description}${reset}`,
    `${dim}  ${accessory.name !== "None" ? `Wearing: ${accessory.name}` : "No accessory"}${reset}`,
    ``,
    `${dim}  "${species.lore}"${reset}`,
    ``,
    statBars,
    `${rc}${bold}${"~".repeat(36)}${reset}`,
  ].join("\n")

  return {
    species: species.name,
    element: element.name,
    title,
    fullName,
    accessory: accessory.name,
    rarity,
    shiny,
    eyes,
    lore: species.lore,
    stats,
    palette,
    ansiPalette,
    label,
    card,
  }
}

// -- Collection Deck (persistent session history) --

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "fs"
import { join } from "path"

export interface DeckEntry {
  sessionId: string
  companion: {
    species: string
    element: string
    title: string
    fullName: string
    accessory: string
    rarity: Rarity
    shiny: boolean
    eyes: string
    lore: string
    stats: Record<string, number>
    palette: { body: string; accent: string; highlight: string; eye: string }
  }
  session: {
    startedAt: string       // ISO timestamp
    endedAt?: string        // ISO timestamp
    cwd: string             // working directory
    model?: string          // LLM model used
    summary?: string        // what was accomplished (set at session end)
    toolCalls?: number      // total tool invocations
    tokensUsed?: number     // total tokens
  }
}

export interface CompanionDeck {
  userId: string
  companions: DeckEntry[]
  stats: {
    totalSessions: number
    speciesSeen: string[]
    rarestPull: Rarity
    shiniesFound: number
    legendaryCount: number
  }
}

function getDeckPath(): string {
  const home = process.env.HOME || process.env.USERPROFILE || "~"
  return join(home, ".8gent", "companion-deck.json")
}

export function loadDeck(): CompanionDeck {
  const deckPath = getDeckPath()
  try {
    if (existsSync(deckPath)) {
      return JSON.parse(readFileSync(deckPath, "utf-8"))
    }
  } catch {}
  return {
    userId: process.env.USER || "unknown",
    companions: [],
    stats: { totalSessions: 0, speciesSeen: [], rarestPull: "common", shiniesFound: 0, legendaryCount: 0 },
  }
}

function saveDeck(deck: CompanionDeck) {
  const deckPath = getDeckPath()
  const dir = join(process.env.HOME || "~", ".8gent")
  mkdirSync(dir, { recursive: true })
  writeFileSync(deckPath, JSON.stringify(deck, null, 2))
}

const RARITY_ORDER: Rarity[] = ["common", "uncommon", "rare", "epic", "legendary"]

export function registerCompanion(sessionId: string, companion: Companion, model?: string): DeckEntry {
  const deck = loadDeck()

  const entry: DeckEntry = {
    sessionId,
    companion: {
      species: companion.species,
      element: companion.element,
      title: companion.title,
      fullName: companion.fullName,
      accessory: companion.accessory,
      rarity: companion.rarity,
      shiny: companion.shiny,
      eyes: companion.eyes,
      lore: companion.lore,
      stats: companion.stats,
      palette: companion.palette,
    },
    session: {
      startedAt: new Date().toISOString(),
      cwd: process.cwd(),
      model,
    },
  }

  deck.companions.push(entry)

  // Update deck stats
  deck.stats.totalSessions = deck.companions.length
  if (!deck.stats.speciesSeen.includes(companion.species)) {
    deck.stats.speciesSeen.push(companion.species)
  }
  if (RARITY_ORDER.indexOf(companion.rarity) > RARITY_ORDER.indexOf(deck.stats.rarestPull)) {
    deck.stats.rarestPull = companion.rarity
  }
  if (companion.shiny) deck.stats.shiniesFound++
  if (companion.rarity === "legendary") deck.stats.legendaryCount++

  saveDeck(deck)
  return entry
}

export function endSession(sessionId: string, summary?: string, toolCalls?: number, tokensUsed?: number) {
  const deck = loadDeck()
  const entry = deck.companions.find(c => c.sessionId === sessionId)
  if (entry) {
    entry.session.endedAt = new Date().toISOString()
    if (summary) entry.session.summary = summary
    if (toolCalls) entry.session.toolCalls = toolCalls
    if (tokensUsed) entry.session.tokensUsed = tokensUsed
    saveDeck(deck)
  }
}

export function formatDeckSummary(): string {
  const deck = loadDeck()
  const reset = "\x1b[0m"
  const bold = "\x1b[1m"
  const dim = "\x1b[2m"

  if (deck.companions.length === 0) {
    return `${dim}No companions yet. Start a session to collect your first.${reset}`
  }

  const lines: string[] = [
    `${bold}Companion Deck - ${deck.userId}${reset}`,
    `${dim}${deck.stats.totalSessions} sessions | ${deck.stats.speciesSeen.length}/${SPECIES.length} species | Rarest: ${deck.stats.rarestPull}${reset}`,
    `${dim}Shinies: ${deck.stats.shiniesFound} | Legendaries: ${deck.stats.legendaryCount}${reset}`,
    "",
  ]

  // Show last 10 companions (most recent first)
  const recent = deck.companions.slice(-10).reverse()
  for (const entry of recent) {
    const rc = RARITY_COLORS[entry.companion.rarity]
    const date = entry.session.startedAt.slice(0, 10)
    const summary = entry.session.summary ? ` - ${entry.session.summary.slice(0, 50)}` : ""
    const shinyTag = entry.companion.shiny ? " *" : ""
    lines.push(
      `  ${rc}${entry.companion.fullName}${shinyTag}${reset} ${dim}[${entry.companion.element}]${reset} ${dim}${date}${summary}${reset}`
    )
  }

  if (deck.companions.length > 10) {
    lines.push(`${dim}  ...and ${deck.companions.length - 10} more${reset}`)
  }

  return lines.join("\n")
}

// -- Standalone test --

if (import.meta.main) {
  const args = process.argv.slice(2)

  if (args[0] === "deck") {
    // Show collection deck
    console.log(formatDeckSummary())
  } else {
    // Generate and register 5 random companions
    for (let i = 0; i < 5; i++) {
      const sessionId = `demo-${i}-${Date.now()}`
      const c = generateCompanion(sessionId)
      registerCompanion(sessionId, c)
      console.log(c.card)
      console.log()
    }
    console.log("\n--- Your Deck ---\n")
    console.log(formatDeckSummary())
  }
}
