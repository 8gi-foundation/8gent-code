# Pet Card Flip - Chat Popover with MTG-Style Companion Card

## Problem
The dock pet chat popover is one-sided. Users click the pet, get a chat window. There's no way to see the companion's identity, stats, or lore.

## Solution
Make the chat popover a flippable card. Front = chat interface (existing). Back = full MTG/Pokemon-style companion profile card.

## Not Doing
- Trading card game mechanics
- Card animations beyond the flip
- New external dependencies

## Design

### Front (Chat - existing)
Keep as-is. Add a small flip button (top-right corner) to switch to card view.

### Back (Companion Card)
Styled like a Magic: The Gathering / Pokemon card:

```
+----------------------------------+
|  [Rarity border glow]           |
|                                  |
|  [Species pixel art - centered]  |
|  (from body.png, scaled)         |
|                                  |
|  ---- name + title bar ----     |
|  "Arcanist Drake"               |
|  [Element badge] Ember           |
|  [Rarity badge] Uncommon         |
|                                  |
|  STATS                           |
|  DEBUG    ████████░░ 16          |
|  CHAOS    ██████░░░░ 12          |
|  WISDOM   ████░░░░░░  8          |
|  PATIENCE ██████████ 20          |
|  SNARK    ████████░░ 16          |
|  ARCANA   ██████░░░░ 12          |
|                                  |
|  [Accessory] Mithril Helm       |
|                                  |
|  "A young dragon. Breathes hot  |
|   takes about framework choices."|
|                                  |
|  [8gent logo] 8gent.dev         |
+----------------------------------+
```

### Card Visual Style
- **Border**: Rarity-colored glow (green/blue/purple/orange/gold)
- **Background**: Dark gradient matching element color
- **Art**: body.png from `apps/lil-eight/parts/{species}/body.png`, scaled to fit card
- **Stats**: Colored bars matching element accent color
- **Typography**: System font, monospace for stats
- **Shiny**: If shiny, add a subtle shimmer overlay

### Flip Animation
- NSView transition using `CATransition` with `kCATransitionFlip`
- Flip direction: left-to-right (like turning a card)
- Duration: 0.4s
- Triggered by: button click OR keyboard shortcut (Tab key)

## Data Source
All data comes from `~/.8gent/active-companion.json`:
```json
{
  "fullName": "Arcanist Drake",
  "species": "Drake",
  "element": "Ember",
  "rarity": "uncommon",
  "accessory": "Mithril Helm",
  "shiny": false,
  "palette": { "body": "#7F1D1D", "accent": "#EF4444", "highlight": "#FF6464", "eye": "#EF4444" },
  "lore": "A young dragon. Breathes hot takes about framework choices.",
  "spriteAtlas": "atlas-drake.png"
}
```

Stats need to be added to active-companion.json - currently not written there.
Update companion JSON write in `apps/tui/src/app.tsx` and `bin/8gent.ts` to include stats.

## Implementation

### File: `apps/lil-eight/LilEight/main.swift`

**Changes needed:**

1. **CompanionCardView** (~150 lines) - New NSView subclass
   - Draws the MTG-style card with all companion data
   - Loads body.png from parts directory
   - Renders stat bars, name, element, rarity, lore
   - Rarity-colored border

2. **ChatPopoverView modification** (~30 lines)
   - Add flip button to top-right
   - Add reference to CompanionCardView
   - Flip transition between chat and card views

3. **CompanionData extension** (~10 lines)
   - Parse `stats`, `lore`, `accessory`, `shiny` from JSON
   - Currently only parses name, species, element, rarity, palette

### File: `apps/tui/src/app.tsx` (line ~1907)
- Add `stats`, `lore` to the companion JSON write

### File: `bin/8gent.ts` (line ~556)
- Add `stats`, `lore` to the companion JSON write

## Steps for Subagent

1. Read the current ChatPopoverView code in main.swift (search for "ChatPopoverView" or "chatPopover")
2. Read CompanionData struct (line ~976)
3. Update CompanionData to parse stats, lore, accessory, shiny from JSON
4. Create CompanionCardView as a new NSView subclass that renders the MTG card
5. Add flip button and transition logic to ChatPopoverView
6. Update companion JSON writes in app.tsx and bin/8gent.ts to include stats + lore
7. Build: `cd apps/lil-eight && bash build.sh`
8. Test: kill pet, update active-companion.json with stats, respawn pet, click, flip

## Verification
1. `bash build.sh` compiles without errors
2. Click pet -> chat popover opens (unchanged)
3. Click flip button -> card flips to companion profile
4. Card shows species art, name, element, rarity, stats, lore
5. Click flip again -> back to chat
6. Rarity border color matches companion rarity
