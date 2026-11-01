# @8gent/video

Remotion compositions for 8gent. Cinematic travel-map videos powered by MapLibre (no API token).

## Run

```bash
bun install
bun --filter @8gent/video start          # opens Remotion Studio
bun --filter @8gent/video render         # renders TokyoToSF.mp4 to out/
bun --filter @8gent/video typecheck      # tsc --noEmit
```

## What's here

- `src/Root.tsx` — registers compositions
- `src/compositions/` — composition entrypoints (`TokyoToSF`)
- `src/templates/` — reusable Remotion components (`TravelMap`, `FlightPath`, `CityLabel`, `CloudOverlay`, `EndCard`)
- `remotion.config.ts` — angle GL + serial concurrency for MapLibre headless renders

## Patterns

Authored from the `RemotionAnimatedMaps` skill at `.claude/skills/RemotionAnimatedMaps/`. That skill is the canonical reference for the camera math, easing, and Remotion-MapLibre contract.

## Future

- LetsFG provider (`packages/travel/letsfg-provider.ts`) feeds route data into a `<TravelMap>` composition for booking confirmations and itinerary previews.
- Render-as-tool: agent calls `render_travel_video({from, to})` and gets back an MP4 URL.
