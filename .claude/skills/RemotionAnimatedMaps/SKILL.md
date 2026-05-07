---
name: RemotionAnimatedMaps
description: Cinematic travel map animations in Remotion using @remotion/maps (MapLibre, no API token). Flight paths with altitude arcs, camera tracking, smooth zooms, animated routes, city labels, cloud overlays. Use when creating travel videos, flight visualizations, location-based animations, LetsFG flight booking visuals, or any cinematic geo-storytelling. Triggers on "flight path animation", "travel map video", "animated map", "remotion maps", "cinematic map", "Tokyo to SF", "fly through map".
---

# RemotionAnimatedMaps

Personal Google Earth for travel videos. Build cinematic map animations in Remotion (camera dollies, glowing flight arcs, animated city labels, drifting clouds) without paying for a Mapbox token.

Primary use case: visualize flights and travel itineraries for the **LetsFG (LetsFlyGuru)** booking and travel-management surface. Plug a route in, get a polished destination teaser out.

## Important factual note about the stack

There is **no** `@remotion/maps` npm package. The Remotion docs at https://www.remotion.dev/docs/maps cover Mapbox (token required) and a MapLibre integration pattern (no token). This skill uses **MapLibre GL JS directly** as the no-token path the user asked for. If a future `@remotion/maps` wrapper ships, the patterns here transfer one-for-one — the geometry, easing, camera math, and layer setup all live above the map library.

Verified on Remotion canonical docs (`https://www.remotion.dev/docs/maps`) at write time:

- `useDelayRender()` with `delayRender('Loading map...')` and `continueRender(handle)` is the integration contract.
- The map container needs explicit `width`/`height` and `position: absolute`.
- Mapbox-side animations must be disabled (`interactive: false`, `fadeDuration: 0`) — the frame is the only clock.
- `_map.remove()` cleanup is **explicitly forbidden** in Remotion's docs.
- `useCurrentFrame()` drives every camera and layer update inside a `useEffect`.
- Recommended render flags: `npx remotion render --gl=angle --concurrency=1`.

The same rules hold for `maplibre-gl`. Read the existing `remotion-best-practices` skill at `~/.claude/skills/remotion-best-practices/` (in particular `rules/maps.md`, `rules/animations.md`, `rules/timing.md`) — this skill composes with it, it does not replace it.

## When to use this skill

- Building a travel-itinerary teaser (flight A to B, multi-stop trips).
- LetsFG flight-booking visualisations: confirmation videos, route previews, cabin-class showcases.
- Any Remotion composition that needs a map with cinematic camera language rather than a static screenshot.
- Demos where a map appears for under 30 seconds and needs to feel like a movie cut, not a slippy widget.

If the goal is interactive maps (panning, click handlers, real-time data), this is the wrong skill — use MapLibre directly in a normal React app.

## Install

```bash
bun add maplibre-gl @turf/turf
# or
npm i maplibre-gl @turf/turf
```

CSS import (once, in the composition entry):

```ts
import 'maplibre-gl/dist/maplibre-gl.css';
```

No token, no env var. MapLibre's demo style works out of the box:

```ts
const STYLE_URL = 'https://demotiles.maplibre.org/style.json';
```

For higher-fidelity raster basemaps without a token, `https://tiles.openfreemap.org/styles/positron` and `https://tiles.openfreemap.org/styles/liberty` are good free options. Pick one with attribution friendly to your output.

## What this skill ships

| File | Role |
| --- | --- |
| `templates/TravelMap.tsx` | Wraps MapLibre with the Remotion contract (delayRender, frame-driven camera, no cleanup). Accepts `from`, `to`, `cameraKeyframes`. |
| `templates/FlightPath.tsx` | Frame-driven great-circle arc with altitude curve, glow trail, leading light dot. |
| `templates/CityLabel.tsx` | Spring-driven label anchored to a lat-lng. Project lat-lng to screen via `map.project()`. |
| `templates/CloudOverlay.tsx` | Soft drifting cloud SVG layer. Pure CSS/SVG, no map dependency. |
| `templates/EndCard.tsx` | Spring-entry destination card. Used for the closing 2-3 second beat. |
| `examples/TokyoToSF.tsx` | Canonical demo — Tokyo to San Francisco, full cinematic sequence. |
| `references/maps-api.md` | Verified `maplibre-gl` API surface used by this skill, with the gotchas. |

## Motion patterns this skill encodes

### 1. Camera as an animated rig, not a slippy map

Every frame, derive the camera and call `map.jumpTo({ center, zoom, pitch, bearing })`. Never call `map.flyTo()` or `map.easeTo()` — those run on real time and will desync from the Remotion frame clock.

```tsx
const frame = useCurrentFrame();
const progress = frame / durationInFrames;
const center = lerpLngLat(from, to, easeInOut(progress));
map.jumpTo({ center, zoom: zoomCurve(progress), pitch: 55, bearing: bearingCurve(progress) });
```

### 2. Spring for arrivals, interpolate for paths

- Path progress (0 to 1 along the great circle): `interpolate()` with `Easing.bezier(0.4, 0, 0.2, 1)`.
- Camera dolly settle on destination: `spring({ frame, fps, config: { damping: 200, mass: 1 } })`.
- Label entry: `spring()` driving opacity AND y-translate together.
- Reason: paths want continuous progress (interpolate's job), arrivals want physical settle (spring's job).

### 3. Altitude arc for flight paths

A flight does not look like a flight if the line sits flat on the map. Lift it.

- Sample the great-circle line densely with `turf.greatCircle()` then `turf.along()`.
- For each sample, compute an altitude offset: `alt = sin(t * Math.PI) * peakAltitudeMeters`.
- Render the line in two passes: a wider blurred glow underneath, a sharper line on top.
- Add a leading "light" dot at progress position, a touch ahead of the trail tail.

### 4. Camera follow with lookahead

Do not center the camera exactly on the trail head — it feels lagged. Project a lookahead point ~8 to 12 percent further along the path and frame between the head and that point. The audience sees what is coming, not what already happened.

### 5. Three-act structure (the skill's default 240-frame at 30fps template)

| Beat | Frames (at 30fps) | What |
| --- | --- | --- |
| Open | 0 to 60 | Tight on origin city, subtle pitch, atmospheric haze, label fades in. |
| Reveal | 60 to 120 | Camera pulls back, route appears, glow trail starts drawing. |
| Travel | 120 to 200 | Camera tracks along path with lookahead, light dot leads, clouds drift. |
| Settle | 200 to 240 | Ease into destination framing, end card springs in. |

Tune frames-per-beat to your actual `durationInFrames`; the ratios (1 / 1 / 1.3 / 0.7) are the cinematic feel.

### 6. Easing the skill prefers

```ts
import { Easing } from 'remotion';
const cinematic = Easing.bezier(0.4, 0, 0.2, 1); // material standard, looks like film
const settle = Easing.bezier(0.16, 1, 0.3, 1);   // ease-out for arrivals
const sineInOut = Easing.inOut(Easing.sin);      // for camera bearing/pitch sweeps
```

### 7. Color rules (from BRAND.md — non-negotiable)

- **No purple, pink, violet** (hues 270 to 350). Banned.
- Default palette: amber `#F59E0B` for trail/glow, soft blue `#3B82F6` for ocean shading, warm white `#FEF3C7` for clouds, deep navy `#0B1E3F` for night-mode framing.
- City labels: warm white text, dark amber halo, no neon.

## Required Remotion contract (do not break)

1. Wrap map init in `useEffect` with empty deps. Hold the map in `useState`.
2. `const [handle] = useState(() => delayRender('Loading map...'))`. Call `continueRender(handle)` on `'load'`.
3. **Do not call `map.remove()`** — Remotion's docs explicitly forbid it.
4. Disable everything time-based on the map: `interactive: false`, `fadeDuration: 0`.
5. The map container element MUST have explicit width, height, and `position: absolute`.
6. For per-frame layer updates, wrap in another `useEffect` keyed on `[frame, map, ...]`, take a fresh `delayRender` handle, mutate the source data, then `map.once('idle', () => continueRender(handle))`.

This contract is mirrored from `~/.claude/skills/remotion-best-practices/rules/maps.md` lines 158-164. If Remotion changes it, update both skills.

## Render flags

```bash
npx remotion render src/index.ts TokyoToSF out.mp4 --gl=angle --concurrency=1
```

`--gl=angle` is required for headless WebGL on macOS. `--concurrency=1` because MapLibre on Chromium does not parallelise reliably under Remotion.

## Honest limits — what is NOT verified

- **No render was executed during skill authoring.** Imports, props, and the MapLibre API are reconciled against the published docs and Remotion's canonical maps rule, but the example compositions have not been frame-rendered to MP4.
- The OpenFreeMap style URLs are public but may rate-limit under heavy parallel rendering — fall back to `demotiles.maplibre.org` if so.
- `turf.greatCircle()` returns a `MultiLineString` when the path crosses the antimeridian (Tokyo-SF does cross it). The `FlightPath` template handles this; if you change endpoints, re-test.

When you ship, verify with one render before iterating: `bunx remotion render src/index.ts TokyoToSF out.mp4 --gl=angle --concurrency=1`.

## How to extend

- Multi-stop trip: chain `FlightPath` segments with sequential `<Sequence>` blocks; reset `progress` per segment.
- Cabin-class showcase (LetsFG): overlay a flight-class card during the travel beat using a regular `<Sequence>`.
- Booking confirmation: feed the route data from your booking API into props; the composition is parametric.
- Live weather: swap the `CloudOverlay` for a real radar tile layer (still no token if you use OpenFreeMap or NOAA tiles).

## See also

- `~/.claude/skills/remotion-best-practices/SKILL.md` — base Remotion patterns. Read first.
- `~/.claude/skills/remotion-best-practices/rules/maps.md` — Mapbox version of these patterns.
- `~/.claude/skills/remotion-best-practices/rules/timing.md` — interpolation and spring reference.
- `~/.claude/skills/AIVideo/` — broader video production orchestration.
