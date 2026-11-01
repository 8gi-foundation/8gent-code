# Maps API reference (verified)

This file documents the exact API surface this skill depends on, with sources.

## Status check on `@remotion/maps`

**`@remotion/maps` does not exist on npm at the time of writing.**

```
$ npm view @remotion/maps version
npm error 404 Not Found - GET https://registry.npmjs.org/@remotion%2fmaps
```

The Remotion docs page at https://www.remotion.dev/docs/maps describes integration patterns for **Mapbox** (token required) and a **MapLibre** alternative (no token). There is no first-party Remotion wrapper component. This skill uses `maplibre-gl` directly, which is the no-token path the user asked for.

If `@remotion/maps` ships in the future, the patterns in this skill (great-circle math, camera keyframing, frame-driven layer updates, spring-driven labels, end-card sequencing) are agnostic to the underlying library and will port one-for-one.

## Required dependencies

| Package | Version range | Why |
| --- | --- | --- |
| `remotion` | >= 4.0 | Core. `delayRender` / `continueRender` are the integration contract. |
| `maplibre-gl` | >= 4.0 | Map renderer. Apache 2.0. No API token. |
| `@turf/turf` | >= 7.0 | Great-circle geometry, line slicing. MIT. |
| `react`, `react-dom` | matches your Remotion version | Standard. |

```bash
bun add remotion maplibre-gl @turf/turf
# or
npm i remotion maplibre-gl @turf/turf
```

## Required CSS import (once per project)

```ts
import 'maplibre-gl/dist/maplibre-gl.css';
```

Without this, MapLibre canvases render but tile labels misalign.

## Remotion contract (verbatim from docs)

From `https://www.remotion.dev/docs/maps` and the `remotion-best-practices/rules/maps.md` skill:

1. Animations must be driven by `useCurrentFrame()`. Map-internal animations (`flyTo`, `easeTo`) are real-time and **must not** be used.
2. Loading the map must use `delayRender('Loading map...')` (imported from `remotion`) with `continueRender(handle)` called on the map's `'load'` event.
3. The container element MUST have explicit `width`, `height`, and `position: 'absolute'`.
4. Map-internal time-based behaviour must be disabled: `interactive: false`, `fadeDuration: 0`.
5. **Do not call `map.remove()`.** Remotion's docs explicitly forbid cleanup here.
6. For per-frame source/layer updates, take a fresh `delayRender` handle inside the per-frame `useEffect`, mutate the source data via `map.getSource(id).setData(...)`, then `map.once('idle', () => continueRender(handle))`.

Render command:

```bash
npx remotion render src/index.ts <CompositionId> out.mp4 --gl=angle --concurrency=1
```

`--gl=angle` for headless WebGL on macOS. `--concurrency=1` because MapLibre under headless Chromium does not parallelise reliably.

## MapLibre GL JS API surface this skill uses

All from `maplibregl` exports:

| Symbol | Use here |
| --- | --- |
| `new maplibregl.Map(opts)` | Constructor. We pass `container`, `style`, `center`, `zoom`, `pitch`, `bearing`, `interactive: false`, `fadeDuration: 0`, `attributionControl: false`. |
| `map.on('load', cb)` | Initial load signal. We chain `map.once('idle')` inside before calling `continueRender`. |
| `map.once('idle', cb)` | Per-frame settle signal. Required so the renderer captures a stable frame. |
| `map.jumpTo({ center, zoom, pitch, bearing })` | Frame-by-frame camera. **Do not** use `flyTo`/`easeTo`. |
| `map.addSource(id, { type: 'geojson', data })` | Trail and head sources. |
| `map.getSource(id).setData(geojson)` | Per-frame trail/head updates. |
| `map.addLayer({ id, type, source, paint, layout })` | Glow line, sharp line, head circle, head dot. |
| `map.project([lng, lat])` | World-to-screen for `CityLabel` DOM overlays. |

### Map options used

```ts
new maplibregl.Map({
  container: HTMLElement,
  style: string | StyleSpecification,
  center: [lng, lat],
  zoom: number,
  pitch: number,        // 0..85
  bearing: number,      // 0..360
  interactive: false,   // required for Remotion
  fadeDuration: 0,      // required for Remotion
  attributionControl: false,
});
```

## Free style URLs (no token)

| URL | Notes |
| --- | --- |
| `https://demotiles.maplibre.org/style.json` | MapLibre's official demo tiles. Always works. Looks basic. |
| `https://tiles.openfreemap.org/styles/positron` | Clean light style. Good for cinematic. May rate-limit at high concurrency. |
| `https://tiles.openfreemap.org/styles/liberty` | Liberty/OpenMapTiles style. Richer detail. |
| `https://tiles.openfreemap.org/styles/bright` | Bright variant. |

For production, host your own style + tiles via OpenFreeMap self-host, or pre-bake tiles.

## Turf.js API used

| Symbol | Use here |
| --- | --- |
| `turf.point([lng, lat])` | Wrap endpoints. |
| `turf.lineString(coords)` | Build geometry for `setData`. |
| `turf.greatCircle(p1, p2, { npoints })` | Sample the great circle. Returns a `Feature<LineString | MultiLineString>`. |
| `turf.length(line)` | (Optional) total km along path; not used in `FlightPath` but useful for camera pacing. |
| `turf.along(line, distance)` | (Optional) sample at km distance. |
| `turf.lineSliceAlong(line, 0, distance)` | (Optional) progressive geodesic slicing — alternative to index-slicing the sampled array. |

## Antimeridian gotcha

Tokyo at lng `+139.78` to SF at lng `-122.38` crosses the antimeridian. `turf.greatCircle` handles this by returning a `MultiLineString` so the line does not visually wrap across the whole map.

`flatGreatCircle` in `templates/FlightPath.tsx` flattens both `LineString` and `MultiLineString` results into a single `LngLat[]`. For most map styles this is fine because MapLibre renders the underlying segments correctly; the index-based slicing we use also works because adjacent samples in the flattened array are spatially close.

If you change endpoints to a longer antimeridian crossing and see line artefacts, switch to `turf.lineSliceAlong` against the original `MultiLineString` features, OR keep the line as a `MultiLineString` source and shorten via per-segment progress.

## Color palette (from BRAND.md)

Banned: hues 270 to 350 (purple, pink, violet).

Use:
- Trail: `#F59E0B` (amber 500)
- Glow: `#FCD34D` (amber 300)
- Ocean tint: `#3B82F6` (blue 500) — only as low-opacity overlay
- Cloud: `#FEF3C7` (amber 100) — warm white
- End-card background: `#0B1E3F` (deep navy)

## What was NOT verified

- A live render of `examples/TokyoToSF.tsx` was not performed during skill authoring. Imports, prop shapes, and the MapLibre/turf API are reconciled against the canonical docs and the existing `remotion-best-practices/rules/maps.md` skill, but no MP4 was produced.
- `https://tiles.openfreemap.org/styles/positron` is reachable at write time; production renders should pin a style URL you control or fall back to the MapLibre demo style.
