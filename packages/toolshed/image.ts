/**
 * 8gent Code - Image Tools
 *
 * Multimodal image reading and description capabilities.
 * Uses sharp for image processing and Ollama vision models for description.
 */

import * as fs from "fs";
import * as path from "path";
import sharp from "sharp";

// ============================================
// Types
// ============================================

export interface ImageInfo {
  path: string;
  base64: string;
  width: number;
  height: number;
  format: string;
  size: number;
  channels: number;
  hasAlpha: boolean;
}

export interface ImageDescription {
  path: string;
  description: string;
  width: number;
  height: number;
  format: string;
  model: string;
}

const SUPPORTED_FORMATS = new Set(["png", "jpg", "jpeg", "gif", "webp"]);

// ============================================
// Image Reading
// ============================================

/**
 * Read an image file and return its base64 encoding along with metadata
 */
export async function readImage(imagePath: string): Promise<ImageInfo> {
  const absolutePath = path.isAbsolute(imagePath)
    ? imagePath
    : path.join(process.cwd(), imagePath);

  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Image not found: ${absolutePath}`);
  }

  const ext = path.extname(absolutePath).toLowerCase().slice(1);
  if (!SUPPORTED_FORMATS.has(ext)) {
    throw new Error(
      `Unsupported image format: ${ext}. Supported: ${Array.from(SUPPORTED_FORMATS).join(", ")}`
    );
  }

  // Read the image with sharp
  const image = sharp(absolutePath);
  const metadata = await image.metadata();
  const buffer = await fs.promises.readFile(absolutePath);
  const base64 = buffer.toString("base64");

  return {
    path: absolutePath,
    base64,
    width: metadata.width || 0,
    height: metadata.height || 0,
    format: metadata.format || ext,
    size: buffer.length,
    channels: metadata.channels || 0,
    hasAlpha: metadata.hasAlpha || false,
  };
}

/**
 * Resize an image for efficient processing
 */
export async function resizeImage(
  imagePath: string,
  maxWidth: number = 800,
  maxHeight: number = 800
): Promise<ImageInfo> {
  const absolutePath = path.isAbsolute(imagePath)
    ? imagePath
    : path.join(process.cwd(), imagePath);

  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Image not found: ${absolutePath}`);
  }

  const image = sharp(absolutePath);
  const metadata = await image.metadata();

  // Resize if needed, maintaining aspect ratio
  const resized = await image
    .resize(maxWidth, maxHeight, {
      fit: "inside",
      withoutEnlargement: true,
    })
    .toBuffer();

  const resizedMetadata = await sharp(resized).metadata();
  const base64 = resized.toString("base64");

  return {
    path: absolutePath,
    base64,
    width: resizedMetadata.width || 0,
    height: resizedMetadata.height || 0,
    format: resizedMetadata.format || metadata.format || "unknown",
    size: resized.length,
    channels: resizedMetadata.channels || 0,
    hasAlpha: resizedMetadata.hasAlpha || false,
  };
}

// ============================================
// Image Description (Ollama Vision)
// ============================================

/**
 * Describe an image using an Ollama vision model
 */
export async function describeImage(
  imagePath: string,
  prompt: string = "Describe this image in detail.",
  model: string = "llava"
): Promise<ImageDescription> {
  // First read and resize the image for efficiency
  const imageInfo = await resizeImage(imagePath, 1024, 1024);

  // Call Ollama with the image
  const response = await fetch("http://localhost:11434/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      prompt,
      images: [imageInfo.base64],
      stream: false,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Ollama vision error: ${response.statusText} - ${error}`);
  }

  const data = (await response.json()) as { response: string };

  return {
    path: imageInfo.path,
    description: data.response,
    width: imageInfo.width,
    height: imageInfo.height,
    format: imageInfo.format,
    model,
  };
}

/**
 * Extract text from an image using OCR via vision model.
 *
 * When no model is specified, auto-discovers the best available OCR model:
 * 1. Local OCR-specialized models (dots.ocr, deepseek-ocr, glm-ocr)
 * 2. Local general vision models with strong OCR (qwen2.5-vl, minicpm-v)
 * 3. Falls back to llava if nothing else is available
 */
export async function extractTextFromImage(
  imagePath: string,
  model?: string
): Promise<ImageDescription> {
  let ocrModel = model || "llava";

  // Auto-discover best OCR model if none specified
  if (!model) {
    try {
      const { findOCRModel } = await import("@8gent/eight/vision-router");
      const result = await findOCRModel();
      if (result.found && result.model?.provider === "ollama") {
        ocrModel = result.model.model;
      }
    } catch {
      // Vision router not available — fall back to llava
    }
  }

  return describeImage(
    imagePath,
    "Extract and transcribe all text visible in this image. Return only the text content, preserving formatting where possible. For tables, preserve the structure. For code, preserve indentation and syntax.",
    ocrModel
  );
}

/**
 * Analyze code in a screenshot
 */
export async function analyzeCodeScreenshot(
  imagePath: string,
  model: string = "llava"
): Promise<ImageDescription> {
  return describeImage(
    imagePath,
    "This is a screenshot of code. Extract the code, identify the programming language, and explain what the code does. Format the code properly.",
    model
  );
}

// ============================================
// Image Utilities
// ============================================

/**
 * Get basic image metadata without loading full content
 */
export async function getImageMetadata(imagePath: string): Promise<{
  path: string;
  width: number;
  height: number;
  format: string;
  size: number;
  channels: number;
  hasAlpha: boolean;
}> {
  const absolutePath = path.isAbsolute(imagePath)
    ? imagePath
    : path.join(process.cwd(), imagePath);

  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Image not found: ${absolutePath}`);
  }

  const stats = fs.statSync(absolutePath);
  const image = sharp(absolutePath);
  const metadata = await image.metadata();

  return {
    path: absolutePath,
    width: metadata.width || 0,
    height: metadata.height || 0,
    format: metadata.format || "unknown",
    size: stats.size,
    channels: metadata.channels || 0,
    hasAlpha: metadata.hasAlpha || false,
  };
}

/**
 * Convert image to a different format
 */
export async function convertImage(
  imagePath: string,
  outputFormat: "png" | "jpg" | "webp" | "gif"
): Promise<Buffer> {
  const absolutePath = path.isAbsolute(imagePath)
    ? imagePath
    : path.join(process.cwd(), imagePath);

  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Image not found: ${absolutePath}`);
  }

  const image = sharp(absolutePath);

  switch (outputFormat) {
    case "png":
      return image.png().toBuffer();
    case "jpg":
      return image.jpeg().toBuffer();
    case "webp":
      return image.webp().toBuffer();
    case "gif":
      return image.gif().toBuffer();
    default:
      throw new Error(`Unsupported output format: ${outputFormat}`);
  }
}

/**
 * Check if Ollama vision model is available
 */
export async function isVisionModelAvailable(
  model: string = "llava"
): Promise<boolean> {
  try {
    const response = await fetch("http://localhost:11434/api/tags");
    if (!response.ok) return false;

    const data = (await response.json()) as {
      models: Array<{ name: string }>;
    };
    return data.models.some(
      (m) => m.name === model || m.name.startsWith(`${model}:`)
    );
  } catch {
    return false;
  }
}
