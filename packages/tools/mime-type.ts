/**
 * MIME type detector - extension mapping and magic byte signatures.
 * Covers common web, document, image, audio, video, and archive types.
 */

const EXTENSION_MAP: Record<string, string> = {
  // Text / Web
  html: "text/html",
  htm: "text/html",
  css: "text/css",
  js: "text/javascript",
  mjs: "text/javascript",
  ts: "text/typescript",
  json: "application/json",
  xml: "application/xml",
  svg: "image/svg+xml",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  yaml: "text/yaml",
  yml: "text/yaml",
  toml: "application/toml",

  // Images
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  ico: "image/x-icon",
  tiff: "image/tiff",
  tif: "image/tiff",
  avif: "image/avif",

  // Audio
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  flac: "audio/flac",
  aac: "audio/aac",
  m4a: "audio/mp4",
  opus: "audio/opus",
  webm: "audio/webm",

  // Video
  mp4: "video/mp4",
  m4v: "video/mp4",
  mpeg: "video/mpeg",
  mpg: "video/mpeg",
  avi: "video/x-msvideo",
  mov: "video/quicktime",
  mkv: "video/x-matroska",
  ogv: "video/ogg",

  // Documents
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",

  // Archives
  zip: "application/zip",
  gz: "application/gzip",
  tar: "application/x-tar",
  bz2: "application/x-bzip2",
  "7z": "application/x-7z-compressed",
  rar: "application/vnd.rar",
  xz: "application/x-xz",

  // Fonts
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",

  // Binary / misc
  wasm: "application/wasm",
  bin: "application/octet-stream",
  exe: "application/x-msdownload",
  dmg: "application/x-apple-diskimage",
};

// Reverse map: MIME -> primary extension
const REVERSE_MAP: Record<string, string> = {};
for (const [ext, mime] of Object.entries(EXTENSION_MAP)) {
  if (!REVERSE_MAP[mime]) REVERSE_MAP[mime] = ext;
}

// Magic byte signatures
type Signature = { offset: number; bytes: number[]; mime: string };

const SIGNATURES: Signature[] = [
  { offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47], mime: "image/png" },
  { offset: 0, bytes: [0xff, 0xd8, 0xff], mime: "image/jpeg" },
  { offset: 0, bytes: [0x47, 0x49, 0x46, 0x38], mime: "image/gif" },
  { offset: 0, bytes: [0x25, 0x50, 0x44, 0x46], mime: "application/pdf" },
  { offset: 0, bytes: [0x50, 0x4b, 0x03, 0x04], mime: "application/zip" },
  { offset: 0, bytes: [0x1f, 0x8b], mime: "application/gzip" },
  { offset: 0, bytes: [0x42, 0x5a, 0x68], mime: "application/x-bzip2" },
  { offset: 0, bytes: [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00], mime: "application/x-xz" },
  { offset: 0, bytes: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c], mime: "application/x-7z-compressed" },
  { offset: 0, bytes: [0xff, 0xfb], mime: "audio/mpeg" },
  { offset: 0, bytes: [0x49, 0x44, 0x33], mime: "audio/mpeg" },
  { offset: 0, bytes: [0x66, 0x4c, 0x61, 0x43], mime: "audio/flac" },
  { offset: 0, bytes: [0x4f, 0x67, 0x67, 0x53], mime: "audio/ogg" },
  { offset: 0, bytes: [0x1a, 0x45, 0xdf, 0xa3], mime: "video/x-matroska" },
  { offset: 0, bytes: [0x00, 0x00, 0x01, 0xba], mime: "video/mpeg" },
  { offset: 0, bytes: [0x00, 0x61, 0x73, 0x6d], mime: "application/wasm" },
  { offset: 0, bytes: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], mime: "application/msword" },
];

function matchSignature(buf: Uint8Array, sig: Signature): boolean {
  if (buf.length < sig.offset + sig.bytes.length) return false;
  return sig.bytes.every((b, i) => buf[sig.offset + i] === b);
}

/**
 * Get MIME type from a filename or file extension.
 * Returns "application/octet-stream" for unknown types.
 */
export function getMimeType(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return EXTENSION_MAP[ext] ?? "application/octet-stream";
}

/**
 * Detect MIME type from the first bytes of a file buffer.
 * Falls back to "application/octet-stream" if no signature matches.
 */
export function detectFromBytes(buffer: Uint8Array): string {
  for (const sig of SIGNATURES) {
    if (matchSignature(buffer, sig)) return sig.mime;
  }
  return "application/octet-stream";
}

/**
 * Get the primary file extension for a given MIME type.
 * Returns undefined if the MIME type is not recognized.
 */
export function getExtension(mime: string): string | undefined {
  return REVERSE_MAP[mime.split(";")[0].trim().toLowerCase()];
}
