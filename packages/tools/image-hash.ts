/**
 * Normalizes image pixels by downsizing and grayscaling.
 * @param pixels - Flat array of RGB values (length = width * height * 3)
 * @param width - Original image width
 * @param height - Original image height
 * @param size - Target size (default 8)
 * @returns Flat array of grayscale values (length = size * size)
 */
function normalize(pixels: number[], width: number, height: number, size: number = 8): number[] {
  const newWidth = size;
  const newHeight = size;
  const result: number[] = [];
  for (let y = 0; y < newHeight; y++) {
    for (let x = 0; x < newWidth; x++) {
      const originalX = Math.floor((x * width) / newWidth);
      const originalY = Math.floor((y * height) / newHeight);
      const originalIndex = (originalY * width + originalX) * 3;
      const r = pixels[originalIndex];
      const g = pixels[originalIndex + 1];
      const b = pixels[originalIndex + 2];
      const gray = 0.299 * r + 0.587 * g + 0.114 * b;
      result.push(gray);
    }
  }
  return result;
}

/**
 * Computes perceptual image hash (pHash) as a bitstring.
 * @param pixels - Flat array of RGB values (length = width * height * 3)
 * @param width - Original image width
 * @param height - Original image height
 * @param size - Target size for hash (default 8)
 * @returns 64-bit string (for size=8)
 */
function pHash(pixels: number[], width: number, height: number, size: number = 8): string {
  const normalized = normalize(pixels, width, height, size);
  const avg = normalized.reduce((sum, val) => sum + val, 0) / normalized.length;
  let hash = '';
  for (const pixel of normalized) {
    hash += pixel > avg ? '1' : '0';
  }
  return hash;
}

/**
 * Computes Hamming distance between two hashes.
 * @param hash1 - First hash string
 * @param hash2 - Second hash string
 * @returns Distance (0-64)
 */
function hamming(hash1: string, hash2: string): number {
  let distance = 0;
  for (let i = 0; i < Math.min(hash1.length, hash2.length); i++) {
    if (hash1[i] !== hash2[i]) {
      distance++;
    }
  }
  return distance;
}

/**
 * Checks if two hashes are similar based on Hamming distance.
 * @param hash1 - First hash string
 * @param hash2 - Second hash string
 * @param threshold - Maximum allowed distance (default 5)
 * @returns True if similar
 */
function isSimilar(hash1: string, hash2: string, threshold: number = 5): boolean {
  return hamming(hash1, hash2) <= threshold;
}

export { normalize, pHash, hamming, isSimilar };