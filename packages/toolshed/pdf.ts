/**
 * 8gent Code - PDF Tools
 *
 * PDF reading and text extraction capabilities.
 * Uses pdf-parse v2 for text extraction.
 */

import * as fs from "fs";
import * as path from "path";
import { PDFParse } from "pdf-parse";

// ============================================
// Types
// ============================================

export interface PdfInfo {
  path: string;
  text: string;
  pageCount: number;
  metadata: PdfMetadata;
}

export interface PdfMetadata {
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string;
  creator?: string;
  producer?: string;
  creationDate?: string;
  modificationDate?: string;
}

export interface PdfPageContent {
  path: string;
  pageNumber: number;
  text: string;
  totalPages: number;
}

// ============================================
// PDF Reading
// ============================================

/**
 * Read a PDF file and extract all text content
 */
export async function readPdf(pdfPath: string): Promise<PdfInfo> {
  const absolutePath = path.isAbsolute(pdfPath)
    ? pdfPath
    : path.join(process.cwd(), pdfPath);

  if (!fs.existsSync(absolutePath)) {
    throw new Error(`PDF not found: ${absolutePath}`);
  }

  const ext = path.extname(absolutePath).toLowerCase();
  if (ext !== ".pdf") {
    throw new Error(`Not a PDF file: ${absolutePath}`);
  }

  const buffer = await fs.promises.readFile(absolutePath);
  const pdf = new PDFParse({ data: buffer });

  // Get text from all pages
  const textResult = await pdf.getText();

  // Get metadata
  const infoResult = await pdf.getInfo();

  // Clean up
  await pdf.destroy();

  return {
    path: absolutePath,
    text: textResult.text,
    pageCount: textResult.total,
    metadata: {
      title: infoResult.info?.Title as string | undefined,
      author: infoResult.info?.Author as string | undefined,
      subject: infoResult.info?.Subject as string | undefined,
      keywords: infoResult.info?.Keywords as string | undefined,
      creator: infoResult.info?.Creator as string | undefined,
      producer: infoResult.info?.Producer as string | undefined,
      creationDate: infoResult.info?.CreationDate?.toString(),
      modificationDate: infoResult.info?.ModDate?.toString(),
    },
  };
}

/**
 * Read a specific page from a PDF file
 */
export async function readPdfPage(
  pdfPath: string,
  pageNum: number
): Promise<PdfPageContent> {
  const absolutePath = path.isAbsolute(pdfPath)
    ? pdfPath
    : path.join(process.cwd(), pdfPath);

  if (!fs.existsSync(absolutePath)) {
    throw new Error(`PDF not found: ${absolutePath}`);
  }

  const buffer = await fs.promises.readFile(absolutePath);
  const pdf = new PDFParse({ data: buffer });

  // Get text with page info
  const textResult = await pdf.getText({ partial: [pageNum] });
  const totalPages = textResult.total;

  // Clean up
  await pdf.destroy();

  // Validate page number
  if (pageNum < 1 || pageNum > totalPages) {
    throw new Error(
      `Invalid page number: ${pageNum}. PDF has ${totalPages} pages.`
    );
  }

  const pageText = textResult.pages.length > 0 ?
    textResult.pages[0].text : "";

  return {
    path: absolutePath,
    pageNumber: pageNum,
    text: pageText,
    totalPages,
  };
}

/**
 * Get PDF metadata without extracting all text
 */
export async function getPdfMetadata(pdfPath: string): Promise<{
  path: string;
  pageCount: number;
  metadata: PdfMetadata;
  size: number;
}> {
  const absolutePath = path.isAbsolute(pdfPath)
    ? pdfPath
    : path.join(process.cwd(), pdfPath);

  if (!fs.existsSync(absolutePath)) {
    throw new Error(`PDF not found: ${absolutePath}`);
  }

  const stats = fs.statSync(absolutePath);
  const buffer = await fs.promises.readFile(absolutePath);
  const pdf = new PDFParse({ data: buffer });

  const infoResult = await pdf.getInfo();

  await pdf.destroy();

  return {
    path: absolutePath,
    pageCount: infoResult.total,
    metadata: {
      title: infoResult.info?.Title as string | undefined,
      author: infoResult.info?.Author as string | undefined,
      subject: infoResult.info?.Subject as string | undefined,
      keywords: infoResult.info?.Keywords as string | undefined,
      creator: infoResult.info?.Creator as string | undefined,
      producer: infoResult.info?.Producer as string | undefined,
      creationDate: infoResult.info?.CreationDate?.toString(),
      modificationDate: infoResult.info?.ModDate?.toString(),
    },
    size: stats.size,
  };
}

/**
 * Search for text within a PDF
 */
export async function searchPdf(
  pdfPath: string,
  query: string,
  caseSensitive: boolean = false
): Promise<{
  path: string;
  query: string;
  matches: Array<{
    text: string;
    position: number;
    context: string;
  }>;
  totalMatches: number;
}> {
  const pdfInfo = await readPdf(pdfPath);
  const text = caseSensitive ? pdfInfo.text : pdfInfo.text.toLowerCase();
  const searchQuery = caseSensitive ? query : query.toLowerCase();

  const matches: Array<{
    text: string;
    position: number;
    context: string;
  }> = [];

  let position = 0;
  while ((position = text.indexOf(searchQuery, position)) !== -1) {
    // Get context around the match (50 chars before and after)
    const contextStart = Math.max(0, position - 50);
    const contextEnd = Math.min(text.length, position + query.length + 50);
    const context = pdfInfo.text.slice(contextStart, contextEnd);

    matches.push({
      text: pdfInfo.text.slice(position, position + query.length),
      position,
      context: (contextStart > 0 ? "..." : "") + context + (contextEnd < text.length ? "..." : ""),
    });

    position += query.length;

    // Limit to 100 matches
    if (matches.length >= 100) break;
  }

  return {
    path: pdfInfo.path,
    query,
    matches,
    totalMatches: matches.length,
  };
}

/**
 * Extract text from a range of pages
 */
export async function readPdfPageRange(
  pdfPath: string,
  startPage: number,
  endPage: number
): Promise<{
  path: string;
  startPage: number;
  endPage: number;
  text: string;
  totalPages: number;
}> {
  const absolutePath = path.isAbsolute(pdfPath)
    ? pdfPath
    : path.join(process.cwd(), pdfPath);

  if (!fs.existsSync(absolutePath)) {
    throw new Error(`PDF not found: ${absolutePath}`);
  }

  const buffer = await fs.promises.readFile(absolutePath);
  const pdf = new PDFParse({ data: buffer });

  // Generate page range array
  const pageRange: number[] = [];
  for (let i = startPage; i <= endPage; i++) {
    pageRange.push(i);
  }

  const textResult = await pdf.getText({ partial: pageRange });
  const totalPages = textResult.total;

  await pdf.destroy();

  // Validate page range
  if (startPage < 1) startPage = 1;
  if (endPage > totalPages) endPage = totalPages;
  if (startPage > endPage) {
    throw new Error(`Invalid page range: ${startPage}-${endPage}`);
  }

  // Join text from all pages
  const fullText = textResult.pages
    .map(p => p.text)
    .join("\n\n--- Page Break ---\n\n");

  return {
    path: absolutePath,
    startPage,
    endPage,
    text: fullText,
    totalPages,
  };
}
