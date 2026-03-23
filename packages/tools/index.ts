/**
 * 8gent Code - Multimodal Tools
 *
 * Export all multimodal file tools for images, PDFs, and Jupyter notebooks.
 */

// Image tools
export {
  readImage,
  resizeImage,
  describeImage,
  extractTextFromImage,
  analyzeCodeScreenshot,
  getImageMetadata,
  convertImage,
  isVisionModelAvailable,
  type ImageInfo,
  type ImageDescription,
} from "./image";

// PDF tools
export {
  readPdf,
  readPdfPage,
  readPdfPageRange,
  getPdfMetadata,
  searchPdf,
  type PdfInfo,
  type PdfPageContent,
  type PdfMetadata,
} from "./pdf";

// Notebook tools
export {
  readNotebook,
  getCell,
  editCell,
  insertCell,
  deleteCell,
  moveCell,
  changeCellType,
  clearAllOutputs,
  createNotebook,
  getNotebookSummary,
  type NotebookCell,
  type NotebookOutput,
  type NotebookMetadata,
  type Notebook,
  type ParsedCell,
  type ParsedOutput,
  type NotebookInfo,
} from "./notebook";

// Rate limiter
export {
  RateLimiter,
  type RateLimitConfig,
} from "./rate-limiter";
