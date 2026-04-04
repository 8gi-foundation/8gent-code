/**
 * 8gent Code - Image Input Component
 *
 * Handles image input in terminal:
 * - Paste/type file paths (e.g., /path/to/image.png)
 * - Drag and drop files (path gets pasted)
 * - Clipboard image detection
 * - iTerm2 inline image display support
 *
 * Note: Terminal drag-and-drop pastes the file path.
 * Users can paste image paths directly.
 */

import React, { useState, useCallback, useEffect, useRef } from "react";
import { Box, useInput } from "ink";
import * as fs from "fs";
import * as path from "path";
import { AppText, MutedText, Label, ShortcutHint, Inline, Stack } from './primitives/index.js';

// ============================================
// Types
// ============================================

export interface ImageAttachment {
  path: string;
  filename: string;
  mimeType: string;
  size: number;
  base64?: string;
}

export interface ImageInputProps {
  onImageAttach: (image: ImageAttachment) => void;
  onImageRemove?: () => void;
  currentImage?: ImageAttachment | null;
  showPreview?: boolean;
}

// Supported image extensions
const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg", ".heic", ".avif"];

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|svg|heic|avif)$/i;

// ============================================
// Utility Functions
// ============================================

/**
 * Check if a path is an image file
 */
export function isImagePath(inputPath: string): boolean {
  const ext = path.extname(inputPath).toLowerCase();
  return IMAGE_EXTENSIONS.includes(ext);
}

/**
 * Normalize a path token from terminal paste / drag-drop (file URLs, quotes, %20).
 */
export function normalizePathToken(raw: string): string {
  let s = raw.trim().replace(/^["'`]|["'`]$/g, "");
  if (!s) return s;
  if (s.startsWith("file:")) {
    try {
      const u = new URL(s);
      let pathname = u.pathname;
      if (process.platform === "win32" && pathname.startsWith("/") && /^\/[A-Za-z]:/.test(pathname)) {
        pathname = pathname.slice(1);
      }
      return decodeURIComponent(pathname.replace(/\+/g, " "));
    } catch {
      s = s.replace(/^file:\/+/, "");
    }
  }
  try {
    s = decodeURIComponent(s);
  } catch {
    /* keep s */
  }
  return s;
}

function resolveIfExists(candidate: string): string | null {
  const abs = path.isAbsolute(candidate) ? candidate : path.resolve(process.cwd(), candidate);
  if (fs.existsSync(abs) && isImagePath(abs)) return abs;
  if (fs.existsSync(candidate) && isImagePath(candidate)) return path.normalize(candidate);
  return null;
}

/**
 * Extract image paths from pasted text
 * Handles:
 * - Direct file paths (Unix / Windows)
 * - file:// and file:/// URLs embedded in text
 * - Quoted paths with spaces
 * - Drag-drop from terminals that paste the path as one token
 */
export function extractImagePaths(text: string): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();

  const push = (resolved: string) => {
    if (!seen.has(resolved)) {
      seen.add(resolved);
      paths.push(resolved);
    }
  };

  const tryToken = (token: string) => {
    const cleaned = normalizePathToken(token);
    if (!cleaned || !IMAGE_EXT_RE.test(cleaned)) return;
    const hit = resolveIfExists(cleaned);
    if (hit) push(hit);
  };

  // Quoted paths (spaces inside)
  const quotedRe = /["']([^"']+\.(?:png|jpe?g|gif|webp|bmp|svg|heic|avif))["']/gi;
  let qm: RegExpExecArray | null;
  while ((qm = quotedRe.exec(text)) !== null) {
    tryToken(qm[1]);
  }

  // file:// URLs
  const fileUrlRe = /file:\/{2,3}[^\s)\]\}'"`]+/gi;
  let fm: RegExpExecArray | null;
  while ((fm = fileUrlRe.exec(text)) !== null) {
    tryToken(fm[0]);
  }

  // Whole trimmed string (single-line drop)
  const whole = text.trim();
  if (whole) tryToken(whole);

  // Whitespace / newline separated tokens
  const parts = text.split(/[\n\r\t]+|\s+/).filter(Boolean);
  for (const part of parts) {
    tryToken(part);
  }

  return paths;
}

/**
 * Strip a filesystem path from text without regex metacharacter issues.
 */
export function stripPathFromText(text: string, resolvedPath: string): string {
  let s = text;
  for (const p of [resolvedPath, resolvedPath.replace(/\\/g, "/")]) {
    if (p) s = s.split(p).join("");
  }
  const rawVariants = [resolvedPath, `file://${resolvedPath}`, `file:///${resolvedPath.replace(/^\//, "")}`];
  for (const v of rawVariants) {
    if (v.length > 4) s = s.split(v).join("");
  }
  return s.replace(/["'`]/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * If the entire input is only an image path (typical terminal drag-drop), attach and return "".
 */
export function consumeIfWholeValueIsImagePath(
  value: string,
  attach: (absolutePath: string) => boolean
): string {
  const t = value.trim();
  if (!t) return value;
  const paths = extractImagePaths(t);
  if (paths.length !== 1) return value;
  const p = paths[0];
  const remainder = stripPathFromText(t, p);
  if (remainder.length > 0) return value;
  return attach(p) ? "" : value;
}

/**
 * Read image file and create attachment
 */
export function readImageFile(imagePath: string): ImageAttachment | null {
  try {
    if (!fs.existsSync(imagePath)) {
      return null;
    }

    const stats = fs.statSync(imagePath);
    const ext = path.extname(imagePath).toLowerCase();
    const mimeTypes: Record<string, string> = {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".bmp": "image/bmp",
      ".svg": "image/svg+xml",
      ".heic": "image/heic",
      ".avif": "image/avif",
    };

    const data = fs.readFileSync(imagePath);
    const base64 = data.toString("base64");

    return {
      path: imagePath,
      filename: path.basename(imagePath),
      mimeType: mimeTypes[ext] || "image/png",
      size: stats.size,
      base64,
    };
  } catch (err) {
    return null;
  }
}

/**
 * Format file size for display
 */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ============================================
// iTerm2 Inline Image Support
// ============================================

/**
 * Generate iTerm2 inline image escape sequence
 * https://iterm2.com/documentation-images.html
 */
export function generateIterm2Image(base64Data: string, options?: {
  width?: string;
  height?: string;
  preserveAspectRatio?: boolean;
  inline?: boolean;
}): string {
  const width = options?.width || "auto";
  const height = options?.height || "auto";
  const preserveAspectRatio = options?.preserveAspectRatio !== false ? 1 : 0;
  const inline = options?.inline !== false ? 1 : 0;

  // OSC 1337 ; File = [args] : base64data BEL
  const params = `width=${width};height=${height};preserveAspectRatio=${preserveAspectRatio};inline=${inline}`;
  return `\x1b]1337;File=${params}:${base64Data}\x07`;
}

/**
 * Check if terminal supports iTerm2 images
 */
export function supportsIterm2Images(): boolean {
  const term = process.env.TERM_PROGRAM;
  return term === "iTerm.app" || term === "WezTerm" || term === "Hyper";
}

// ============================================
// Components
// ============================================

/**
 * Image preview badge
 */
export function ImageBadge({
  image,
  onRemove,
  maxNameLen = 36,
}: {
  image: ImageAttachment;
  onRemove?: () => void;
  maxNameLen?: number;
}) {
  const name =
    image.filename.length > maxNameLen
      ? `${image.filename.slice(0, maxNameLen - 1)}…`
      : image.filename;
  return (
    <Inline gap={0} borderStyle="round" borderColor="cyan" paddingX={1}>
      <AppText color="cyan" bold>
        {"\u25A3 "}
      </AppText>
      <Label>{name}</Label>
      <MutedText> {formatSize(image.size)}</MutedText>
      {onRemove && <MutedText dimColor> · esc</MutedText>}
    </Inline>
  );
}

/**
 * Image attachment indicator
 */
export function ImageIndicator({
  image,
  compact = false,
}: {
  image: ImageAttachment;
  compact?: boolean;
}) {
  if (compact) {
    return (
      <AppText color="cyan" bold>
        {"\u25A3 "}
        {image.filename}
      </AppText>
    );
  }

  return (
    <Stack>
      <Inline gap={0}>
        <AppText color="cyan" bold>
          {"\u25A3 "}
        </AppText>
        <Label>Attached</Label>
        <Label>{image.filename}</Label>
      </Inline>
      <Box paddingLeft={3}>
        <MutedText>
          {formatSize(image.size)} · {image.mimeType}
        </MutedText>
      </Box>
    </Stack>
  );
}

/**
 * Main image input handler
 */
export function ImageInput({
  onImageAttach,
  onImageRemove,
  currentImage,
  showPreview = true,
}: ImageInputProps) {
  const [dragHint, setDragHint] = useState(false);

  // Handle keyboard for removing image
  useInput((input, key) => {
    // Ctrl+Backspace or Ctrl+D to remove image
    if (currentImage && key.ctrl && (key.backspace || key.delete || input === "d")) {
      onImageRemove?.();
    }
  });

  if (!currentImage) {
    return (
      <Box>
        <MutedText>
          Drop image file here (pastes path) or paste a file path
        </MutedText>
      </Box>
    );
  }

  return (
    <Stack>
      {showPreview ? (
        <ImageIndicator image={currentImage} />
      ) : (
        <ImageBadge image={currentImage} onRemove={onImageRemove} />
      )}
      <Box paddingLeft={3}>
        <ShortcutHint keys="[Ctrl+D]" description="to remove" />
      </Box>
    </Stack>
  );
}

// ============================================
// Hook for Image Input Integration
// ============================================

export interface UseImageInputOptions {
  onAttach?: (image: ImageAttachment) => void;
  onRemove?: () => void;
}

export function useImageInput(options: UseImageInputOptions = {}) {
  const onAttachRef = useRef(options.onAttach);
  const onRemoveRef = useRef(options.onRemove);
  useEffect(() => {
    onAttachRef.current = options.onAttach;
    onRemoveRef.current = options.onRemove;
  }, [options.onAttach, options.onRemove]);

  const [currentImage, setCurrentImage] = useState<ImageAttachment | null>(null);
  const currentImageRef = useRef<ImageAttachment | null>(null);
  useEffect(() => {
    currentImageRef.current = currentImage;
  }, [currentImage]);

  /**
   * Process input text for image paths
   * Returns remaining text after removing image path
   */
  const processInput = useCallback((input: string): { text: string; image: ImageAttachment | null } => {
    const imagePaths = extractImagePaths(input);

    if (imagePaths.length > 0) {
      const image = readImageFile(imagePaths[0]);
      if (image) {
        setCurrentImage(image);
        currentImageRef.current = image;
        onAttachRef.current?.(image);

        let remaining = input;
        for (const p of imagePaths) {
          remaining = stripPathFromText(remaining, p);
        }

        return { text: remaining, image };
      }
    }

    return { text: input, image: null };
  }, []);

  const attachImage = useCallback((imagePath: string) => {
    const image = readImageFile(imagePath);
    if (image) {
      setCurrentImage(image);
      currentImageRef.current = image;
      onAttachRef.current?.(image);
      return true;
    }
    return false;
  }, []);

  const removeImage = useCallback(() => {
    setCurrentImage(null);
    currentImageRef.current = null;
    onRemoveRef.current?.();
  }, []);

  /** Same-frame attachment (after processInput / attachImage) when React state has not flushed yet */
  const getAttachedImage = useCallback((): ImageAttachment | null => currentImageRef.current, []);

  return {
    currentImage,
    processInput,
    attachImage,
    removeImage,
    getAttachedImage,
    hasImage: !!currentImage,
  };
}

// ============================================
// Exports
// ============================================

export default {
  ImageInput,
  ImageBadge,
  ImageIndicator,
  useImageInput,
  isImagePath,
  extractImagePaths,
  readImageFile,
  generateIterm2Image,
  supportsIterm2Images,
};
