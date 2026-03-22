# 8gent Brand System

Canonical brand reference for all 8gent ecosystem repositories. Mutable by maintainers.

---

## Typography

| Role | Font | Weight |
|------|------|--------|
| Wordmark | Fraunces | 800 |
| Headings | Fraunces | 700 |
| Body / UI | Inter | 400-600 |
| Code | JetBrains Mono | 400-500 |

## Logo

- Wordmark: "8gent" set in Fraunces 800 with an orange period (accent color)
- The "8" references infinity
- No animation on the wordmark
- No gradients on the wordmark

## Color Palette

Warm only. No cool grays, no blue-grays. Banned hues: 270-350 (purple, pink, violet, magenta).

### Accent

| Token | Hex | Usage |
|-------|-----|-------|
| Primary orange | `#E8610A` | Default accent |
| Dark mode variant | `#F07A28` | Accent in dark contexts |

### Dark Mode

| Token | Hex |
|-------|-----|
| bg-0 | `#0A0908` |
| bg-1 | `#12100E` |
| bg-2 | `#1C1A17` |
| bg-3 | `#252220` |
| text-primary | `#FAF7F4` |
| text-secondary | `#C8C2BA` |
| text-tertiary | `#8A8078` |
| border | `#2E2A26` |

### Light Mode

| Token | Hex |
|-------|-----|
| bg-0 | `#FFFDF9` |
| bg-1 | `#FFF8F0` |
| bg-2 | `#FFF3E8` |
| text-primary | `#1A1612` |
| text-secondary | `#5C544A` |
| text-tertiary | `#9A9088` |
| border | `#E8E0D6` |

## Default Themes

Dark mode is the default for developer and OS products.

| Product | Domain | Wordmark | Theme |
|---------|--------|----------|-------|
| 8gent OS | 8gentos.com | 8gentOS. | Dark |
| 8gent Code | 8gent.dev | 8gent Code. | Dark |
| 8gent | 8gent.app | 8gent. | Dark |
| 8gent World | 8gent.world | 8gent. | Dark |
| 8gent Games | 8gent.games | 8gent. | Dark |
| 8gent Jr | 8gentjr.com | 8gent Jr. | Light/Warm |

## Iconography

- SVG icons, Lucide-style stroke preferred
- Stroke width: 1.75px, round caps and joins
- No emojis in production UI

## Animation

- Library: Framer Motion (React projects)
- Transitions: 0.3s
- Entrance: 0.4s
- Hero: 0.5s
- Staggered children animations are the standard pattern

## Writing

- No em dashes - use hyphens or rewrite the sentence
- No enthusiasm inflation
- Direct, clear communication
- Earned praise only

## Exemptions

- **Partner integrations** may use their own brand colors alongside 8gent's
- **Accessibility modes** may override palette constraints for contrast requirements
- **Enterprise/white-label** deployments may customize within warm palette range
- **8gent Games** has an additional cyberpunk palette: neon green `#22c55e` on dark backgrounds
