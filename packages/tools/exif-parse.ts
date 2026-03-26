/**
 * Extracts EXIF metadata from a JPEG buffer.
 * @param buffer - The JPEG file as a Uint8Array.
 * @returns An object with EXIF fields or null if parsing fails.
 */
export function parse(buffer: Uint8Array): ExifMetadata | null {
  let offset = 0;
  if (buffer[offset] !== 0xFF || buffer[offset + 1] !== 0xD8) return null;
  offset += 2;

  while (offset < buffer.length) {
    if (buffer[offset] === 0xFF) {
      const marker = buffer[offset + 1];
      if (marker === 0xE1) {
        const length = (buffer[offset + 2] << 8) | buffer[offset + 3];
        offset += 4;

        if (
          buffer[offset] !== 'E'.charCodeAt(0) ||
          buffer[offset + 1] !== 'X'.charCodeAt(0) ||
          buffer[offset + 2] !== 'I'.charCodeAt(0) ||
          buffer[offset + 3] !== 'F'.charCodeAt(0)
        ) {
          return null;
        }
        offset += 4;

        const byteOrder = buffer[offset] === 0x49 ? 'II' : 'MM';
        offset += 2;
        const ifdOffset = readUInt32(buffer, offset, byteOrder);
        offset += 4;
        offset = ifdOffset;

        const entries = parseIFD(buffer, offset, byteOrder);
        return {
          make: entries.get(0x010F) as string | null,
          model: entries.get(0x0110) as string | null,
          dateTime: entries.get(0x0132) as string | null,
          width: entries.get(0x0100) as number | null,
          height: entries.get(0x0101) as number | null,
        };
      }

      const segmentLength = (buffer[offset + 2] << 8) | buffer[offset + 3];
      offset += 2 + segmentLength;
    } else {
      return null;
    }
  }

  return null;
}

/**
 * Interface for EXIF metadata fields.
 */
export interface ExifMetadata {
  make: string | null;
  model: string | null;
  dateTime: string | null;
  width: number | null;
  height: number | null;
}

/**
 * Reads a 16-bit unsigned integer from buffer.
 * @param buffer - The buffer.
 * @param offset - The offset in buffer.
 * @param byteOrder - 'II' for little-endian, 'MM' for big-endian.
 * @returns The integer value.
 */
function readUInt16(buffer: Uint8Array, offset: number, byteOrder: string): number {
  if (byteOrder === 'II') {
    return buffer[offset] | (buffer[offset + 1] << 8);
  } else {
    return (buffer[offset] << 8) | buffer[offset + 1];
  }
}

/**
 * Reads a 32-bit unsigned integer from buffer.
 * @param buffer - The buffer.
 * @param offset - The offset in buffer.
 * @param byteOrder - 'II' for little-endian, 'MM' for big-endian.
 * @returns The integer value.
 */
function readUInt32(buffer: Uint8Array, offset: number, byteOrder: string): number {
  if (byteOrder === 'II') {
    return (
      buffer[offset] |
      (buffer[offset + 1] << 8) |
      (buffer[offset + 2] << 16) |
      (buffer[offset + 3] << 24)
    );
  } else {
    return (
      (buffer[offset] << 24) |
      (buffer[offset + 1] << 16) |
      (buffer[offset + 2] << 8) |
      buffer[offset + 3]
    );
  }
}

/**
 * Parses IFD entries from buffer.
 * @param buffer - The buffer.
 * @param offset - The offset in buffer.
 * @param byteOrder - 'II' for little-endian, 'MM' for big-endian.
 * @returns A map of tag IDs to values.
 */
function parseIFD(buffer: Uint8Array, offset: number, byteOrder: string): Map<number, any> {
  const entries = new Map<number, any>();

  while (offset < buffer.length) {
    const tag = readUInt16(buffer, offset, byteOrder);
    const type = readUInt16(buffer, offset + 2, byteOrder);
    const count = readUInt32(buffer, offset + 4, byteOrder);
    const valueOffset = readUInt32(buffer, offset + 8, byteOrder);
    offset += 12;

    let value;
    if (type === 2 && count <= 0x7F) {
      value = new TextDecoder().decode(buffer.subarray(offset, offset + count));
      offset += count;
    } else if (type === 3 && count === 1) {
      value = readUInt16(buffer, valueOffset, byteOrder);
    } else if (type === 3 && count === 2) {
      value = {
        width: readUInt16(buffer, valueOffset, byteOrder),
        height: readUInt16(buffer, valueOffset + 2, byteOrder),
      };
    } else {
      continue;
    }

    entries.set(tag, value);
    if (valueOffset === 0) break;
  }

  return entries;
}