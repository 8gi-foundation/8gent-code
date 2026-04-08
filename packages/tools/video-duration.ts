/**
 * Parses video duration from MP4/WebM container headers.
 * @param buffer - Uint8Array buffer containing file header data.
 * @returns {duration: number, format: 'mp4' | 'webm'} or null if unsupported.
 */
export function parse(buffer: Uint8Array): { duration: number; format: 'mp4' | 'webm' } | null {
  if (buffer.length < 4) return null;

  // Check for MP4
  if (buffer[0] === 0x66 && buffer[1] === 0x74 && buffer[2] === 0x79 && buffer[3] === 0x70) {
    const moovOffset = findBox(buffer, 'moov');
    if (moovOffset !== null) {
      const mvhdOffset = findBox(buffer.slice(moovOffset), 'mvhd');
      if (mvhdOffset !== null) {
        const offset = moovOffset + mvhdOffset;
        const version = buffer[offset + 0];
        const timescale = readUint32(buffer, offset + 12);
        const duration = version === 0 ? readUint32(buffer, offset + 20) : readUint64(buffer, offset + 20);
        return { duration: duration / timescale, format: 'mp4' };
      }
    }
  }

  // Check for WebM
  if (buffer[0] === 0x1A && buffer[1] === 0x45 && buffer[2] === 0xDF && buffer[3] === 0x17) {
    let pos = 4;
    while (pos < buffer.length && pos < 1 << 20) {
      const id = readUint32(buffer, pos);
      pos += 4;
      if (id === 0x18538067) { // Segment ID
        const size = readUint64(buffer, pos);
        pos += 8;
        while (pos < buffer.length && pos < pos + size) {
          const elemId = readUint32(buffer, pos);
          pos += 4;
          if (elemId === 0x23) { // Duration ID
            const elemSize = readUint64(buffer, pos);
            pos += 8;
            const duration = parseFloat(buffer.slice(pos, pos + elemSize).toString());
            return { duration, format: 'webm' };
          }
          pos += readUint64(buffer, pos);
        }
      }
      pos += readUint64(buffer, pos);
    }
  }

  return null;
}

/**
 * Finds a box by type in an MP4 buffer.
 * @param buffer - Uint8Array buffer.
 * @param type - 4-character box type (e.g. 'moov').
 * @returns Offset of the box or null.
 */
function findBox(buffer: Uint8Array, type: string): number | null {
  let pos = 0;
  while (pos < buffer.length && pos < 1 << 20) {
    const size = readUint32(buffer, pos);
    const boxType = String.fromCharCode(buffer[pos + 4], buffer[pos + 5], buffer[pos + 6], buffer[pos + 7]);
    if (boxType === type) return pos;
    pos += size;
    if (size === 1 << 32) pos += 8; // 64-bit size
  }
  return null;
}

/**
 * Reads a 32-bit unsigned integer from buffer.
 */
function readUint32(buffer: Uint8Array, pos: number): number {
  return (buffer[pos] << 24) | (buffer[pos + 1] << 16) | (buffer[pos + 2] << 8) | buffer[pos + 3];
}

/**
 * Reads a 64-bit unsigned integer from buffer.
 */
function readUint64(buffer: Uint8Array, pos: number): number {
  return (readUint32(buffer, pos) << 32) | readUint32(buffer, pos + 4);
}