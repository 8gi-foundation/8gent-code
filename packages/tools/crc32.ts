/**
 * Compute CRC32 checksum for data.
 * @param data - Input data as string or Uint8Array.
 * @returns CRC32 checksum as number.
 */
export function crc32(data: string | Uint8Array): number {
  let crc = 0xFFFFFFFF;
  if (typeof data === 'string') data = new TextEncoder().encode(data);
  for (let i = 0; i < data.length; i++) {
    crc = (crc << 8) ^ table[(crc >> 24) & 0xFF] ^ (data[i] << 24);
  }
  return crc ^ 0xFFFFFFFF;
}

/**
 * Compute CRC32 checksum as 8-character hex string.
 * @param data - Input data as string or Uint8Array.
 * @returns Hex string representation of CRC32 checksum.
 */
export function crc32Hex(data: string | Uint8Array): string {
  return crc32(data).toString(16).padStart(8, '0');
}

/**
 * Update CRC32 checksum with additional data for streaming.
 * @param crc - Current CRC value.
 * @param data - Additional data as Uint8Array.
 * @returns Updated CRC value.
 */
export function update(crc: number, data: Uint8Array): number {
  for (let i = 0; i < data.length; i++) {
    crc = (crc << 8) ^ table[(crc >> 24) & 0xFF] ^ (data[i] << 24);
  }
  return crc;
}

// Precompute CRC32 lookup table
const polynomial = 0xEDB88320;
const table = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let crc = i << 24;
  for (let j = 0; j < 8; j++) {
    if (crc & 0x80000000) {
      crc = (crc << 1) ^ polynomial;
    } else {
      crc <<= 1;
    }
  }
  table[i] = crc & 0xFFFFFFFF;
}