/**
 * 8gent Code - PDF Tools
 *
 * PDF reading and text extraction capabilities.
 * Uses pdf-parse for text extraction.
 */

import * as fs from "fs";
import * as path from "path";
import pdfParse from "pdf-parse";

// ============================================
// Types
// ============================================

export interface PdfInfo {
  path: string;
  text: string;
  pageCount: number;
  metadata: PdfMetadata;
  info: PdfDocInfo;
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

export interface PdfDocInfo {
  PDFFormatVersion?: string;
  IsAcroFormPresent?: boolean;
  IsXFAPresent?: boolean;
  IsCollectionPresent?: boolean;
  IsLinearized?: boolean;
  IsSignaturesPresent?: boolean;
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
  const data = await pdfParse(buffer);

  return {
    path: absolutePath,
    text: data.text,
    pageCount: data.numpages,
    metadata: {
      title: data.info?.Title,
      author: data.info?.Author,
      subject: data.info?.Subject,
      keywords: data.info?.Keywords,
      creator: data.info?.Creator,
      producer: data.info?.Producer,
      creationDate: data.info?.CreationDate,
      modificationDate: data.info?.ModDate,
    },
    info: {
      PDFFormatVersion: data.info?.PDFFormatVersion,
      IsAcroFormPresent: data.info?.IsAcroFormPresent,
      IsXFAPresent: data.info?.IsXFAPresent,
      IsCollectionPresent: data.info?.IsCollectionPresent,
      IsLinearized: data.info?.IsLinearized,
      IsSignaturesPresent: data.info?.IsSignaturesPresent,
    },
  };
}

/**
 * Read a specific page from a PDF file
 *
 * Note: pdf-parse extracts all text at once, so we need to split by page markers.
 * This is an approximation as PDF text extraction doesn't always have clear page boundaries.
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

  // Custom page render function to extract specific page
  let pageTexts: string[] = [];
  let currentPage = 0;

  const options = {
    pagerender: function (pageData: {
      pageIndex: number;
      getTextContent: () => Promise<{
        items: Array<{ str: string }>;
      }>;
    }) {
      return pageData.getTextContent().then(function (textContent) {
        let text = "";
        for (const item of textContent.items) {
          text += item.str + " ";
        }
        pageTexts.push(text.trim());
        currentPage++;
        return text;
      });
    },
  };

  const data = await pdfParse(buffer, options);

  // Validate page number
  if (pageNum < 1 || pageNum > data.numpages) {
    throw new Error(
      `Invalid page number: ${pageNum}. PDF has ${data.numpages} pages.`
    );
  }

  // Get the specific page text (1-indexed)
  const pageText = pageTexts[pageNum - 1] || "";

  return {
    path: absolutePath,
    pageNumber: pageNum,
    text: pageText,
    totalPages: data.numpages,
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

  // Use a minimal render to just get metadata
  const options = {
    max: 0, // Don't extract any pages for text
  };

  const data = await pdfParse(buffer, options);

  return {
    path: absolutePath,
    pageCount: data.numpages,
    metadata: {
      title: data.info?.Title,
      author: data.info?.Author,
      subject: data.info?.Subject,
      keywords: data.info?.Keywords,
      creator: data.info?.Creator,
      producer: data.info?.Producer,
      creationDate: data.info?.CreationDate,
      modificationDate: data.info?.ModDate,
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

  let pageTexts: string[] = [];

  const options = {
    pagerender: function (pageData: {
      pageIndex: number;
      getTextContent: () => Promise<{
        items: Array<{ str: string }>;
      }>;
    }) {
      return pageData.getTextContent().then(function (textContent) {
        let text = "";
        for (const item of textContent.items) {
          text += item.str + " ";
        }
        pageTexts.push(text.trim());
        return text;
      });
    },
  };

  const data = await pdfParse(buffer, options);

  // Validate page range
  if (startPage < 1) startPage = 1;
  if (endPage > data.numpages) endPage = data.numpages;
  if (startPage > endPage) {
    throw new Error(`Invalid page range: ${startPage}-${endPage}`);
  }

  // Get text from the specified range (1-indexed)
  const rangeText = pageTexts.slice(startPage - 1, endPage).join("\n\n--- Page Break ---\n\n");

  return {
    path: absolutePath,
    startPage,
    endPage,
    text: rangeText,
    totalPages: data.numpages,
  };
}
