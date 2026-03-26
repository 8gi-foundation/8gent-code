/**
 * Sanitize SVG string by removing script, foreignObject, and event handlers.
 * @param svg - Input SVG string
 * @returns Cleaned SVG string
 */
export function sanitize(svg: string): string {
  let result = svg;
  result = removeScripts(result);
  result = removeForeignObjects(result);
  result = removeHandlers(result);
  return result;
}

/**
 * Remove <script> tags from SVG string.
 * @param svg - Input SVG string
 * @returns SVG string without script tags
 */
export function removeScripts(svg: string): string {
  return svg.replace(/<script[^>]*>.*?<\/script>/gis, '');
}

/**
 * Remove on* attributes from SVG string.
 * @param svg - Input SVG string
 * @returns SVG string without on* attributes
 */
export function removeHandlers(svg: string): string {
  return svg.replace(/on[^=]+=(?:["'].*?["']|[^"\s>]+)/gi, '');
}

/**
 * Check if SVG string is clean (no unsafe elements or attributes).
 * @param svg - Input SVG string
 * @returns True if SVG is clean
 */
export function isClean(svg: string): boolean {
  return !/<script[^>]*>.*?<\/script>|<foreignObject[^>]*>.*?<\/foreignObject>|on[^=]+=(?:["'].*?["']|[^"\s>]+)/gi.test(svg);
}

function removeForeignObjects(svg: string): string {
  return svg.replace(/<foreignObject[^>]*>.*?<\/foreignObject>/gis, '');
}