# 8gent Companion NFT Strategy

## Current State

The companion system at `packages/pet/companion.ts` already has strong NFT-ready DNA:

- **Deterministic generation** from session ID (seeded RNG) - same seed = same companion, provable on-chain
- **40 species** across 5 rarity tiers (common 60%, uncommon 25%, rare 10%, epic 4%, legendary 1%)
- **10 elements**, **29 accessories**, **shiny variant** (1%), **6 stats** (DEBUG, CHAOS, WISDOM, PATIENCE, SNARK, ARCANA)
- **Local collection** in `~/.8gent/companion-deck.json` with session metadata (timestamps, model used, tool calls, tokens)
- **Session-bound lore** - each companion carries what the dev actually built that session

This is already a gacha system. The NFT layer is about making it persistent, tradeable, and a funnel.

---

## 1. Chain Selection: Base (Coinbase L2)

**Winner: Base**

| Chain | Mint cost | Audience | Developer tooling | Social layer | Verdict |
|-------|-----------|----------|-------------------|-------------|---------|
| **Base** | ~$0.001-0.01 | Developers, crypto-native builders | Thirdweb, Coinbase Wallet SDK, OnchainKit | Farcaster integration native | **Best fit** |
| Solana | ~$0.001 | Broader crypto audience | Metaplex, but different ecosystem | Limited social | Good alternative |
| Polygon | ~$0.01 | Enterprise, gaming | Mature EVM tooling | No native social | Too corporate |
| Zora | ~$0.001 | Creators, artists | Zora Protocol SDK | Zora social feed | Art-focused, not dev-focused |

**Why Base:**
- Coinbase Smart Wallet means users can mint with just an email - no MetaMask friction
- Farcaster (where developer crypto-Twitter lives) has native Base NFT rendering
- OnchainKit (by Coinbase) provides React components for minting - fits the Ink/React architecture of 8gent
- Sub-cent gas fees on L2
- Developer audience overlap is highest - Base is where builders already are
- Coinbase Wallet has a companion app that shows NFTs natively

**Solana as secondary target** if you want to cast a wider net later. Different standard (Metaplex), different tooling, but even lower fees.

---

## 2. User Flow

```
PHASE 1: EARN (free, no crypto needed)
  npm install -g @podjamz/8gent-code
  -> User codes a session
  -> Companion spawns (current system, unchanged)
  -> Companion saved to local deck (~/.8gent/companion-deck.json)
  -> Session ends, companion gets summary + stats

PHASE 2: CLAIM (optional, free mint)
  -> User runs: 8gent companion mint
  -> OR clicks "Mint" button in TUI after session
  -> Prompted to connect wallet (Coinbase Smart Wallet - email only, no extension)
  -> Companion metadata + on-chain SVG uploaded to Base
  -> NFT minted to user's wallet (gasless, sponsored by 8gent)
  -> Companion in local deck gets tokenId and txHash fields

PHASE 3: COLLECT (engagement loop)
  -> User sees their on-chain collection at 8gent.dev/deck/{address}
  -> Leaderboard: who has the most legendaries, shinies, unique species
  -> Trading unlocked once marketplace integration is live
  -> Rare companions unlock perks in 8gent OS (paid product)
```

Key principle: **No crypto knowledge required to earn.** The NFT layer is opt-in. Users who never mint still have the full companion experience locally.

---

## 3. Metadata Standard: ERC-1155 on Base

**ERC-1155 over ERC-721.** Here is why:

- A single contract manages ALL companion types (not one contract per companion)
- Batch minting is cheaper (mint 5 companions from 5 sessions in one tx)
- Can represent both unique (1-of-1 shinies) and semi-fungible tokens (common companions)
- OpenSea, Reservoir, and all major marketplaces support ERC-1155

**Metadata structure** (follows OpenSea metadata standard):

```json
{
  "name": "Archmagus Phoenix [Ember]",
  "description": "Rises from git stash. Your code was never truly lost.",
  "image": "data:image/svg+xml;base64,...",
  "animation_url": null,
  "attributes": [
    { "trait_type": "Species", "value": "Phoenix" },
    { "trait_type": "Element", "value": "Ember" },
    { "trait_type": "Title", "value": "Archmagus" },
    { "trait_type": "Accessory", "value": "Materia Orb" },
    { "trait_type": "Rarity", "value": "Rare" },
    { "trait_type": "Shiny", "value": "No" },
    { "trait_type": "Eyes", "value": "o" },
    { "display_type": "number", "trait_type": "DEBUG", "value": 14, "max_value": 20 },
    { "display_type": "number", "trait_type": "CHAOS", "value": 8, "max_value": 20 },
    { "display_type": "number", "trait_type": "WISDOM", "value": 17, "max_value": 20 },
    { "display_type": "number", "trait_type": "PATIENCE", "value": 11, "max_value": 20 },
    { "display_type": "number", "trait_type": "SNARK", "value": 19, "max_value": 20 },
    { "display_type": "number", "trait_type": "ARCANA", "value": 15, "max_value": 20 },
    { "trait_type": "Session Date", "value": "2026-03-25" },
    { "trait_type": "Model Used", "value": "qwen3.5:32b" },
    { "trait_type": "Session Summary", "value": "Refactored auth middleware" }
  ],
  "external_url": "https://8gent.dev/companion/0x.../{tokenId}"
}
```

The session metadata (what was built, model used, date) makes each NFT a **proof-of-work artifact**. This is not just a collectible - it is a record of what you shipped.

---

## 4. On-Chain SVG Rendering (Fully On-Chain Art)

**Yes, do this. It is the killer differentiator.**

The Loot Project proved that fully on-chain generative art creates a culture. No IPFS dependency. No broken images. The art lives forever in the contract.

**Approach: Contract-generated SVG**

```solidity
function tokenURI(uint256 tokenId) public view returns (string memory) {
    CompanionTraits memory traits = decodeTraits(tokenId);
    string memory svg = generateSVG(traits);
    string memory json = generateJSON(traits, svg);
    return string(abi.encodePacked(
        "data:application/json;base64,",
        Base64.encode(bytes(json))
    ));
}
```

**SVG design**: A companion card showing:
- Species pixel art (8x8 or 12x12 grid, colors from element palette)
- Name, title, element badge
- Stat bars (like the terminal card already generates)
- Rarity border glow (color from RARITY_COLORS)
- Shiny sparkle effect (CSS animation in SVG)
- 8gent brandmark (#E8610A accent)

**Why this matters for developers**: Developers respect fully on-chain art. It is technically interesting. It is permanent. It shows craft. IPFS-hosted JPEGs feel cheap by comparison.

**Implementation**: Use the Solmate + OpenZeppelin pattern. The SVG rendering library fits in ~200 lines of Solidity. Reference: Loot, Blitmap, Chain Runners - all fully on-chain.

---

## 5. Revenue Model

### Tier 1: Free Mint (the funnel)
- Every companion from 8gent Code is free to mint
- 8gent sponsors the gas (< $0.01 per mint on Base, budget ~$100/month covers 10,000 mints)
- This is a marketing cost, not a revenue line
- Purpose: get wallets connected, build collection habit

### Tier 2: Royalties on Secondary Sales (passive revenue)
- 5% royalty on all secondary marketplace trades
- ERC-2981 royalty standard (enforced by OpenSea, Reservoir, etc.)
- Revenue scales with collection popularity and trading volume

### Tier 3: Premium Companions (the real money)
- **8gent OS subscribers** get access to premium companion pools:
  - "Mythic" tier above legendary (0.1% drop rate, OS-exclusive)
  - Seasonal limited editions (holiday themes, milestone celebrations)
  - "Fusion" - combine two companions to create a new one (burns the originals, creates scarcity)
  - Custom companion skins/accessories purchasable with a token or fiat
- **Battle Pass model**: Monthly companion pass ($5-10/month) unlocks:
  - Guaranteed rare+ companion per week
  - Exclusive seasonal species
  - Companion XP boost (companions level up with sessions)
  - Bundled into 8gent OS subscription

**What NOT to do:**
- Do not charge for basic minting. Friction kills onboarding.
- Do not make paid companions strictly better. Cosmetically distinct, not mechanically superior.
- Do not create artificial scarcity that punishes free users.

---

## 6. The 8gent OS On-Ramp (Product Strategy)

| Free (8gent Code) | Paid (8gent OS) |
|---|---|
| Local companions | Cloud-synced deck |
| Basic 40 species | +20 Mythic species |
| Manual mint | Auto-mint every session |
| No evolution | Companion evolution chains |
| No fusion | Fusion system |
| Solo collection | Guild/team collections |
| Local leaderboard | Global leaderboard + rankings |
| Basic companion card | Animated companion card (SVG animation) |
| No perks | Companion perks (custom themes, sounds) |

**The psychological loop:**

1. **Hook**: Developer installs 8gent Code. First session, they get a companion. It is cute, it has lore, it has stats. They smile.
2. **Investment**: After 5 sessions, they have a small collection. They got an uncommon. They want a rare.
3. **Social proof**: They see on Farcaster/Twitter that someone pulled a Legendary Bahamut. They want one.
4. **Scarcity**: They realize legendary is 1% per session. They need to use 8gent more.
5. **FOMO**: Seasonal companions expire. "Frostbite Kitsune" is only available in December.
6. **Upgrade trigger**: They see that 8gent OS has Mythic companions, auto-evolution, fusion. The free tier feels limiting.
7. **Conversion**: They subscribe to 8gent OS.

**Key metric to track**: Sessions-per-user-before-conversion. Hypothesis: users who pull a rare+ companion within first 10 sessions convert at 2-3x higher rate.

**On-chain identity**: The companion wallet becomes the user's 8gent identity. Their wallet address links their free 8gent Code usage to their paid 8gent OS account. One identity, one collection, across all 6 products.

---

## 7. Relevant Tools

### Must-use (build with these)

| Tool | Role | Why |
|------|------|-----|
| **OpenZeppelin Contracts** | ERC-1155 base contract | Industry standard, audited, gas-optimized |
| **Foundry** | Smart contract development + testing | Fast, Solidity-native testing, better than Hardhat |
| **Thirdweb** | Minting SDK + React hooks | Handles wallet connection, gasless minting, metadata upload |
| **Coinbase OnchainKit** | Wallet connection UI | Email-based smart wallets, zero friction |
| **Pinata** | Backup metadata storage (IPFS) | For off-chain metadata backup alongside on-chain SVG |

### Nice-to-have (add later)

| Tool | Role | When |
|------|------|------|
| **Reservoir** | Marketplace aggregation API | When trading goes live |
| **Alchemy NFT API** | Collection analytics, ownership queries | When you need dashboards |
| **Arweave** | Permanent storage for session logs | If you want session histories permanently archived |

### Do NOT use
- Truffle/Ganache - legacy, Foundry is strictly better
- Moralis - over-abstracted, unnecessary dependency
- Rarible Protocol - too opinionated for custom generative art
- Manifold - designed for artists, not programmatic minting

---

## 8. Scarcity and Value

**Current rarity math:**
- Legendary species: 1% chance per session
- Shiny: 1% independent roll
- Legendary + Shiny: 0.01% (1 in 10,000 sessions)
- Specific legendary (e.g., Bahamut): 0.25% (1 in 400)
- Specific legendary + shiny + specific element: ~0.0025% (1 in 40,000)

**Value drivers:**
1. **Provable scarcity**: On-chain minting means anyone can verify total supply
2. **Session metadata as provenance**: Each companion carries what was built
3. **Time-locked scarcity**: First-100-users companions are permanently scarce
4. **Ecosystem utility**: Legendaries grant custom themes, priority access, voting rights
5. **Composability**: Other projects could build on top

---

## 9. Trading and Marketplace

**Phase 1 (launch)**: No marketplace, just minting. Shows up on OpenSea/Base automatically.

**Phase 2 (traction)**: 8gent.dev/deck as collection viewer. Global stats, leaderboard.

**Phase 3 (scale)**: In-app trading in 8gent.app. Fusion marketplace (burn 2, get 1 higher tier).

---

## 10. Avoiding NFT Cringe

1. **Never say "NFT" in the UI.** Call them "Companion Cards" or "Companions"
2. **The value is the experience, not the token.** Fun without minting.
3. **No financialization language.** No floor price, no "alpha", no "moon"
4. **Technical credibility.** Fully on-chain SVG, open-source contract, deterministic generation
5. **No hidden admin minting, no pre-mine, no team allocation.**
6. **Opt-in, never forced.** No wallet prompts on first launch.
7. **Developer-native distribution.** Hacker News, Farcaster, GitHub README

---

## Tech Stack Summary

| Layer | Technology |
|-------|-----------|
| **Chain** | Base (Coinbase L2) |
| **Contract standard** | ERC-1155 (OpenZeppelin) |
| **Contract framework** | Foundry |
| **On-chain art** | SVG generation in Solidity (~200 lines) |
| **Wallet connection** | Coinbase Smart Wallet (OnchainKit) |
| **Minting SDK** | Thirdweb or Viem + Wagmi |
| **Gasless minting** | Coinbase Paymaster (OnchainKit) |
| **Metadata backup** | Pinata (IPFS) |
| **Marketplace** | OpenSea + Reservoir (existing) |
| **Collection viewer** | 8gent.dev/deck (Next.js + OnchainKit) |

---

## MVP Scope (~1 week)

| Component | Effort | Files |
|-----------|--------|-------|
| Solidity contract (ERC-1155 + SVG renderer) | 2-3 days | 2-3 .sol files |
| Mint CLI command (`8gent companion mint`) | 1 day | 1-2 .ts files |
| Wallet connection flow | 1 day | 1-2 .ts files |
| DeckEntry schema update (add tokenId, txHash) | 30 min | companion.ts |
| Collection viewer page (8gent.dev/deck) | 2 days | 3-4 files |
| **Total MVP** | **~1 week** | **~10 files** |

### What to Build First
1. Write the ERC-1155 contract with on-chain SVG generation
2. Deploy to Base Sepolia testnet
3. Add `8gent companion mint` CLI command
4. Test: run session -> get companion -> mint it -> see on OpenSea testnet
5. Ship to mainnet when it works
