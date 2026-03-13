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

import React, { useState, useCallback } from "react";
import { Box, Text, useInput } from "ink";
import * as fs from "fs";
import * as path from "path";

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
const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"];

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
 * Extract image paths from pasted text
 * Handles:
 * - Direct file paths
 * - file:// URLs
 * - Paths with quotes (from drag-drop)
 */
export function extractImagePaths(text: string): string[] {
  const paths: string[] = [];

  // Remove quotes and handle file:// URLs
  let cleaned = text.trim();
  cleaned = cleaned.replace(/^["']|["']$/g, ""); // Remove surrounding quotes
  cleaned = cleaned.replace(/^file:\/\//, ""); // Remove file:// prefix
  cleaned = decodeURIComponent(cleaned); // Decode URL encoding

  // Check if it's a valid image path
  if (isImagePath(cleaned) && fs.existsSync(cleaned)) {
    paths.push(cleaned);
  }

  // Also check for multiple paths (space or newline separated)
  const parts = text.split(/[\n\r\s]+/).filter(Boolean);
  for (const part of parts) {
    let partCleaned = part.replace(/^["']|["']$/g, "");
    partCleaned = partCleaned.replace(/^file:\/\//, "");
    partCleaned = decodeURIComponent(partCleaned);

    if (isImagePath(partCleaned) && fs.existsSync(partCleaned) && !paths.includes(partCleaned)) {
      paths.push(partCleaned);
    }
  }

  return paths;
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
}: {
  image: ImageAttachment;
  onRemove?: () => void;
}) {
  return (
    <Box borderStyle="round" borderColor="magenta" paddingX={1}>
      <Text color="magenta">📷 </Text>
      <Text bold>{image.filename}</Text>
      <Text dimColor> ({formatSize(image.size)})</Text>
      {onRemove && (
        <Text dimColor> [x]</Text>
      )}
    </Box>
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
      <Text color="magenta">
        📷 {image.filename}
      </Text>
    );
  }

  return (
    <Box flexDirection="column">
      <Box>
        <Text color="magenta" bold>📷 Image attached: </Text>
        <Text bold>{image.filename}</Text>
      </Box>
      <Box paddingLeft={3}>
        <Text dimColor>
          {formatSize(image.size)} • {image.mimeType}
        </Text>
      </Box>
    </Box>
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
        <Text dimColor>
          📷 Drag image or paste path to attach
        </Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {showPreview ? (
        <ImageIndicator image={currentImage} />
      ) : (
        <ImageBadge image={currentImage} onRemove={onImageRemove} />
      )}
      <Box paddingLeft={3}>
        <Text dimColor>
          [Ctrl+D] to remove
        </Text>
      </Box>
    </Box>
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
  const [currentImage, setCurrentImage] = useState<ImageAttachment | null>(null);

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
        options.onAttach?.(image);

        // Remove the image path from input
        let remaining = input;
        for (const p of imagePaths) {
          remaining = remaining.replace(p, "").replace(/["']/g, "").trim();
        }

        return { text: remaining, image };
      }
    }

    return { text: input, image: null };
  }, [options]);

  const attachImage = useCallback((imagePath: string) => {
    const image = readImageFile(imagePath);
    if (image) {
      setCurrentImage(image);
      options.onAttach?.(image);
      return true;
    }
    return false;
  }, [options]);

  const removeImage = useCallback(() => {
    setCurrentImage(null);
    options.onRemove?.();
  }, [options]);

  return {
    currentImage,
    processInput,
    attachImage,
    removeImage,
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
