# mime-type

**Tool:** `packages/tools/mime-type.ts`
**Status:** quarantine

## Description

Detects MIME types from file extensions and magic byte signatures. Supports reverse lookup from MIME type to file extension.

## Exports

- `getMimeType(filename: string): string` - maps file extension to MIME type
- `detectFromBytes(buffer: Uint8Array): string` - reads magic bytes to identify type
- `getExtension(mime: string): string | undefined` - reverse lookup, MIME to extension

## Coverage

- Web: HTML, CSS, JS, TS, JSON, XML, SVG, YAML, TOML
- Images: PNG, JPEG, GIF, WebP, BMP, ICO, TIFF, AVIF
- Audio: MP3, WAV, OGG, FLAC, AAC, Opus
- Video: MP4, MKV, AVI, MOV, WebM, MPEG
- Documents: PDF, DOCX, XLSX, PPTX, DOC, XLS, PPT
- Archives: ZIP, GZ, BZ2, XZ, 7Z, RAR, TAR
- Fonts: WOFF, WOFF2, TTF, OTF
- Binary: WASM, EXE, DMG

## Integration Path

Wire into agent file operations in `packages/eight/tools.ts` when reading or writing files - use `getMimeType` to set correct content-type headers for uploads, and `detectFromBytes` to validate file type before processing user-provided files.

No external dependencies. Self-contained, zero runtime overhead.
