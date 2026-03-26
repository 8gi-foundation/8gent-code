/**
 * CRC32 checksum calculator for data integrity verification.
 * Lookup table optimized, supports strings, buffers, and streaming.
 */

// Generate CRC32 lookup table (IEEE 802.3 polynomial)
const TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c;
  }
  return table;
})();

function toBytes(data: string | Uint8Array | Buffer): Uint8Array {
  if (typeof data === 'string') {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(data);
    return Buffer.from(data, 'utf8');
  }
  if (data instanceof Uint8Array) return data;
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

export function crc32(data: string | Uint8Array | Buffer): number {
  let c = 0xffffffff;
  const bytes = toBytes(data);
  for (let i = 0; i < bytes.length; i++) {
    c = TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

export function crc32hex(data: string | Uint8Array | Buffer): string {
  return crc32(data).toString(16).padStart(8, '0');
}

export function crc32Continue(prevCrc: number, data: string | Uint8Array | Buffer): number {
  let c = (prevCrc ^ 0xffffffff) >>> 0;
  const bytes = toBytes(data);
  for (let i = 0; i < bytes.length; i++) {
    c = TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

export class CRC32Stream {
  private _acc: number;
  constructor() { this._acc = 0xffffffff; }
  update(data: string | Uint8Array | Buffer): this {
    const bytes = toBytes(data);
    let c = this._acc;
    for (let i = 0; i < bytes.length; i++) {
      c = TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    }
    this._acc = c;
    return this;
  }
  digest(): number { return (this._acc ^ 0xffffffff) >>> 0; }
  digestHex(): string { return this.digest().toString(16).padStart(8, '0'); }
  reset(): this { this._acc = 0xffffffff; return this; }
}
