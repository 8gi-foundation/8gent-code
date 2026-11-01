# @8gent/pet - Companion System

Every 8gent session spawns a unique companion. Your collection is your coding history.

## Quick Start

```bash
# In the TUI
/pet start      # Spawn dock companion + show card
/pet stop       # Dismiss
/pet deck       # View your collection
/pet card       # Roll a new card

# Standalone
bun run packages/pet/companion.ts        # Generate 5 random companions
bun run packages/pet/companion.ts deck   # View your deck
bun run packages/pet/terminal-pet.ts     # Terminal pet mode
```

## How It Works

1. Session starts - companion generated from seeded RNG (session ID as seed)
2. Species, element, title, accessory, stats, rarity all rolled
3. Companion registered in `~/.8gent/companion-deck.json`
4. On macOS, dock pet spawns with companion's name and colors
5. Session ends - summary attached to that companion's deck entry

Same session ID always produces the same companion (deterministic).

## Rarity

| Tier | Chance | Species Count |
|------|--------|---------------|
| Common | 60% | 12 |
| Uncommon | 25% | 11 |
| Rare | 10% | 8 |
| Epic | 4% | 5 |
| Legendary | 1% | 4 |
| Shiny | 1% (independent) | any |

## Species (40)

**Common**: Imp, Goblin, Sprite, Slime, Familiar, Gremlin, Kobold, Wisp, Patchling, Bytebug, Nullpup, Sparkmote

**Uncommon**: Drake, Golem, Wraith, Basilisk, Gryphon, Elemental, Chimera, Patchbeast, Voltaur, Hexacat, Recursaur

**Rare**: Phoenix, Ent, Djinn, Wyrm, Kitsune, Chocobot, Gigavolt, Mooglemancer

**Epic**: Leviathan, Archon, Behemoth, Mewtwo, Treebeard

**Legendary**: Bahamut, Sauron, Arceus, Sephiroth

## Elements (10)

| Element | Color | Philosophy |
|---------|-------|-----------|
| Void | #6B21A8 | Control. Secrets. Null pointers. |
| Ember | #EF4444 | Speed. Destruction. Force push. |
| Aether | #3B82F6 | Logic. Counterspells. Type safety. |
| Verdant | #22C55E | Growth. Recursion. Self-evolution. |
| Radiant | #F59E0B | Order. Purity. Clean architecture. |
| Chrome | #A1A1AA | Artifice. Machines. Zero dependencies. |
| Prism | #A78BFA | Chaos. Multiverse. Quantum bugs. |
| Frost | #67E8F9 | Patience. Immutability. Frozen state. |
| Thunder | #FACC15 | Speed. Parallelism. Async lightning. |
| Shadow | #EC4899 | Stealth. Dark mode. Null-safe. |

## Accessories (29)

Pokeball, Great Ball, Ultra Ball, Master Ball, GS Ball, Wizard Hat, Monocle, Scarf, Tiny Sword, Bandana, Lantern, Spell Tome, Iron Crown, Buster Sword, Chocobo Feather, Phoenix Feather, Mithril Helm, Third Eye, Evenstar, Materia Orb, Infinity Gauntlet, Silmaril, Black Lotus, Limit Break Band, One Ring, Masamune, Triforce

## Stats

6 stats per companion, rolled 3-20 (boosted by rarity):

- **DEBUG** - debugging aptitude
- **CHAOS** - unpredictability
- **WISDOM** - architectural insight
- **PATIENCE** - tolerance for long tasks
- **SNARK** - personality sharpness
- **ARCANA** - mystical coding power

## Titles (31)

Common: Apprentice, Vagrant, Scribe, Tinker, Scout, Novice, Trainer, Ranger

Uncommon: Arcanist, Sentinel, Alchemist, Warden, Invoker, Artificer, Gym Leader, Dark Knight

Rare: Archmagus, Paladin, Chronomancer, Summoner, Sage, Elite Four, Dragoon

Epic: Planeswalker, Lich King, Astral Watcher, Champion

Legendary: Omniscient, World Ender, First Coder

## Files

| File | Purpose |
|------|---------|
| `companion.ts` | Companion generator, deck collection, seeded RNG |
| `terminal-pet.ts` | ANSI terminal pet renderer (cross-platform) |
| `PetWidget.tsx` | Ink (React CLI) component for TUI embedding |
| `package.json` | Package metadata (@8gent/pet) |

## Deck Storage

`~/.8gent/companion-deck.json` - persistent collection across sessions.

Each entry stores:
- Companion identity (species, element, title, accessory, rarity, shiny, stats, palette)
- Session metadata (start/end time, cwd, model, summary, tool calls, tokens)

## Dock Pet Bridge (macOS)

`/pet start` writes `~/.8gent/active-companion.json` with the companion's palette and name. The Swift dock pet (`apps/lil-eight/`) reads this on launch to set its name label and color tint.

## Future: NFT Minting

Companions are designed to be mintable as on-chain SVG NFTs on Base (Coinbase L2). See `docs/COMPANION-NFT-STRATEGY.md` for the full plan.
