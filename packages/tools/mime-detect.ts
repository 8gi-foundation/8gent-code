/**
 * Detect MIME type from buffer using magic bytes.
 * @param buffer - Uint8Array of file data
 * @returns MIME type string or null
 */
export function detect(buffer: Uint8Array): string | null {
   const signatures = [
      { signature: 'ffd8ff', length: 3, mime: 'image/jpeg' },
      { signature: '89504e470d0a1a0a', length: 8, mime: 'image/png' },
      { signature: '474946383961', length: 6, mime: 'image/gif' },
      { signature: '52494646', length: 4, mime: 'image/webp' },
      { signature: '00000018', length: 4, mime: 'video/mp4' },
      { signature: '1a45dfaa', length: 4, mime: 'video/webm' },
      { signature: 'fffb', length: 2, mime: 'audio/mpeg' },
      { signature: '25504446', length: 4, mime: 'application/pdf' },
      { signature: '504b0304', length: 4, mime: 'application/zip' },
      { signature: '1f8b08', length: 3, mime: 'application/gzip' },
   ];
   for (const sig of signatures) {
      if (buffer.length >= sig.length) {
         let hex = '';
         for (let i = 0; i < sig.length; i++) {
            hex += buffer[i].toString(16).padStart(2, '0');
         }
         if (hex.toLowerCase() === sig.signature) {
            return sig.mime;
         }
      }
   }
   return null;
}

/**
 * Get hex signature from buffer.
 * @param buffer - Uint8Array of file data
 * @returns Hex string of first 8 bytes
 */
export function getMagic(buffer: Uint8Array): string {
   let hex = '';
   for (let i = 0; i < 8 && i < buffer.length; i++) {
      hex += buffer[i].toString(16).padStart(2, '0');
   }
   return hex.toLowerCase();
}

/**
 * Check if buffer is an image.
 * @param buffer - Uint8Array of file data
 * @returns True if image MIME type
 */
export function isImage(buffer: Uint8Array): boolean {
   const mime = detect(buffer);
   return mime ? mime.startsWith('image/') : false;
}