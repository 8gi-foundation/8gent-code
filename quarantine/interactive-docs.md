# Interactive Docs - Quarantine

## What

Standalone HTML page that visualizes 8gent's architecture interactively. No build step, no dependencies beyond Google Fonts CDN.

## File

`apps/docs/interactive-architecture.html`

## Features

- 9 Powers rendered as hoverable hexagon nodes (SVG, no library deps)
- Core infrastructure (Daemon, Agent Loop, Tools, System Prompt) as pulsing circle nodes
- Data flow lines animate between connected components, highlight on hover
- Detail tooltip shows description, package path, and tech tags
- Touch-friendly (touchstart/touchend handlers)
- Brand colors: #E8610A orange, #1A1A2E dark, Inter font
- Responsive via SVG viewBox scaling

## Deployment

Drop the HTML file at `8gent.world/architecture`. No build required.

## Inspiration

@ericzakariasson's interactive animations for technical concepts (hover-to-explore pattern).

## Constraints

- Single file, ~150 lines of JS, zero npm deps
- Plain SVG - no D3 needed for this complexity level
- No modifications to existing files
