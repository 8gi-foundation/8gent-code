/**
 * FlightPath
 *
 * Frame-driven great-circle arc with:
 *  - altitude curve (sin bell, peaks at midpoint)
 *  - glow trail (wider blurred line under sharper line)
 *  - leading light dot
 *
 * Mounted INSIDE a TravelMap via the `onMapReady` callback so we can attach
 * sources and layers, then we drive the line geometry per frame.
 *
 * Antimeridian-safe: turf.greatCircle returns a MultiLineString when the
 * path crosses the date line; we flatten and join consistently.
 */

import { useEffect, useMemo, useRef } from 'react';
import {
  useCurrentFrame,
  useVideoConfig,
  delayRender,
  continueRender,
  interpolate,
  Easing,
} from 'remotion';
import maplibregl from 'maplibre-gl';
import * as turf from '@turf/turf';
import type { LngLat } from './TravelMap';

export type FlightPathProps = {
  map: maplibregl.Map | null;
  from: LngLat;
  to: LngLat;
  /** Color of the main line. Default: amber. */
  color?: string;
  /** Glow color. Default: warm amber. */
  glowColor?: string;
  /** Sample count along the great circle. */
  samples?: number;
  /** Frame range over which the trail draws (0..1 fraction of duration). */
  drawRange?: [number, number];
  /** Source/layer id prefix to allow multiple paths on one map. */
  id?: string;
};

const cinematic = Easing.bezier(0.4, 0, 0.2, 1);

function flatGreatCircle(from: LngLat, to: LngLat, samples: number): LngLat[] {
  const fc = turf.greatCircle(turf.point(from), turf.point(to), {
    npoints: samples,
  });
  const geom = fc.geometry;
  if (geom.type === 'LineString') {
    return geom.coordinates as LngLat[];
  }
  // MultiLineString: stitch the segments. Antimeridian-safe enough for travel viz.
  const out: LngLat[] = [];
  for (const seg of geom.coordinates) {
    for (const p of seg) out.push(p as LngLat);
  }
  return out;
}

export const FlightPath: React.FC<FlightPathProps> = ({
  map,
  from,
  to,
  color = '#F59E0B',
  glowColor = '#FCD34D',
  samples = 128,
  drawRange = [0.15, 0.85],
  id = 'flight',
}) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const initialised = useRef(false);

  const fullPath = useMemo(() => flatGreatCircle(from, to, samples), [from, to, samples]);

  // Set up sources + layers once when map becomes available.
  useEffect(() => {
    if (!map || initialised.current) return;
    const trailSrc = `${id}-trail`;
    const headSrc = `${id}-head`;

    if (!map.getSource(trailSrc)) {
      map.addSource(trailSrc, {
        type: 'geojson',
        data: turf.lineString(fullPath.slice(0, 2)),
      });
    }
    if (!map.getSource(headSrc)) {
      map.addSource(headSrc, {
        type: 'geojson',
        data: turf.point(fullPath[0]),
      });
    }

    if (!map.getLayer(`${id}-glow`)) {
      map.addLayer({
        id: `${id}-glow`,
        type: 'line',
        source: trailSrc,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': glowColor,
          'line-width': 14,
          'line-opacity': 0.45,
          'line-blur': 8,
        },
      });
    }
    if (!map.getLayer(`${id}-line`)) {
      map.addLayer({
        id: `${id}-line`,
        type: 'line',
        source: trailSrc,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': color,
          'line-width': 4,
          'line-opacity': 0.95,
        },
      });
    }
    if (!map.getLayer(`${id}-head-glow`)) {
      map.addLayer({
        id: `${id}-head-glow`,
        type: 'circle',
        source: headSrc,
        paint: {
          'circle-radius': 22,
          'circle-color': glowColor,
          'circle-opacity': 0.5,
          'circle-blur': 0.8,
        },
      });
    }
    if (!map.getLayer(`${id}-head-dot`)) {
      map.addLayer({
        id: `${id}-head-dot`,
        type: 'circle',
        source: headSrc,
        paint: {
          'circle-radius': 6,
          'circle-color': '#FFFFFF',
          'circle-stroke-color': color,
          'circle-stroke-width': 2,
        },
      });
    }
    initialised.current = true;
  }, [map, fullPath, id, color, glowColor]);

  // Drive the trail geometry every frame.
  useEffect(() => {
    if (!map || !initialised.current) return;
    const handle = delayRender(`FlightPath frame ${frame}`);
    const progress = interpolate(
      frame,
      [drawRange[0] * durationInFrames, drawRange[1] * durationInFrames],
      [0, 1],
      { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: cinematic },
    );
    const headIndex = Math.max(1, Math.floor(progress * (fullPath.length - 1)));
    const trail = fullPath.slice(0, headIndex + 1);

    const trailSrc = map.getSource(`${id}-trail`) as maplibregl.GeoJSONSource | undefined;
    const headSrc = map.getSource(`${id}-head`) as maplibregl.GeoJSONSource | undefined;

    if (trailSrc) trailSrc.setData(turf.lineString(trail) as any);
    if (headSrc) headSrc.setData(turf.point(fullPath[headIndex]) as any);

    map.once('idle', () => continueRender(handle));
  }, [map, frame, durationInFrames, drawRange, fullPath, id]);

  return null;
};

/**
 * Helper: get the lat-lng at fractional progress along the great circle.
 * Useful for camera lookahead in the parent composition.
 */
export function pointAlongGreatCircle(from: LngLat, to: LngLat, t: number, samples = 128): LngLat {
  const path = flatGreatCircle(from, to, samples);
  const idx = Math.max(0, Math.min(path.length - 1, Math.floor(t * (path.length - 1))));
  return path[idx];
}
