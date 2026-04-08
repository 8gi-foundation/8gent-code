/**
 * 8gent Code - Jupyter Notebook Tools
 *
 * Read and edit Jupyter notebooks (.ipynb files).
 * Notebooks are JSON files with a specific structure.
 */

import * as fs from "fs";
import * as path from "path";

// ============================================
// Types
// ============================================

export interface NotebookCell {
  id?: string;
  cell_type: "code" | "markdown" | "raw";
  source: string[] | string;
  metadata: Record<string, unknown>;
  execution_count?: number | null;
  outputs?: NotebookOutput[];
}

export interface NotebookOutput {
  output_type: "stream" | "execute_result" | "display_data" | "error";
  name?: string;
  text?: string[] | string;
  data?: Record<string, string[] | string>;
  execution_count?: number;
  ename?: string;
  evalue?: string;
  traceback?: string[];
}

export interface NotebookMetadata {
  kernelspec?: {
    display_name: string;
    language: string;
    name: string;
  };
  language_info?: {
    name: string;
    version?: string;
    codemirror_mode?: string | { name: string; version: number };
    file_extension?: string;
    mimetype?: string;
    nbconvert_exporter?: string;
    pygments_lexer?: string;
  };
  [key: string]: unknown;
}

export interface Notebook {
  nbformat: number;
  nbformat_minor: number;
  metadata: NotebookMetadata;
  cells: NotebookCell[];
}

export interface ParsedCell {
  index: number;
  id?: string;
  type: "code" | "markdown" | "raw";
  source: string;
  executionCount?: number | null;
  outputs: ParsedOutput[];
}

export interface ParsedOutput {
  type: string;
  text?: string;
  data?: Record<string, string>;
  error?: {
    name: string;
    value: string;
    traceback: string[];
  };
}

export interface NotebookInfo {
  path: string;
  nbformat: number;
  nbformat_minor: number;
  kernel?: string;
  language?: string;
  cellCount: number;
  cells: ParsedCell[];
}

// ============================================
// Notebook Reading
// ============================================

/**
 * Read a Jupyter notebook and parse its cells
 */
export async function readNotebook(notebookPath: string): Promise<NotebookInfo> {
  const absolutePath = path.isAbsolute(notebookPath)
    ? notebookPath
    : path.join(process.cwd(), notebookPath);

  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Notebook not found: ${absolutePath}`);
  }

  const ext = path.extname(absolutePath).toLowerCase();
  if (ext !== ".ipynb") {
    throw new Error(`Not a Jupyter notebook: ${absolutePath}`);
  }

  const content = await fs.promises.readFile(absolutePath, "utf-8");
  const notebook: Notebook = JSON.parse(content);

  // Parse cells
  const parsedCells: ParsedCell[] = notebook.cells.map((cell, index) => {
    // Normalize source to string
    const source = Array.isArray(cell.source)
      ? cell.source.join("")
      : cell.source;

    // Parse outputs
    const outputs: ParsedOutput[] = (cell.outputs || []).map((output) => {
      const parsed: ParsedOutput = { type: output.output_type };

      if (output.text) {
        parsed.text = Array.isArray(output.text)
          ? output.text.join("")
          : output.text;
      }

      if (output.data) {
        parsed.data = {};
        for (const [key, value] of Object.entries(output.data)) {
          parsed.data[key] = Array.isArray(value) ? value.join("") : value;
        }
      }

      if (output.output_type === "error") {
        parsed.error = {
          name: output.ename || "Error",
          value: output.evalue || "",
          traceback: output.traceback || [],
        };
      }

      return parsed;
    });

    return {
      index,
      id: cell.id,
      type: cell.cell_type,
      source,
      executionCount: cell.execution_count,
      outputs,
    };
  });

  return {
    path: absolutePath,
    nbformat: notebook.nbformat,
    nbformat_minor: notebook.nbformat_minor,
    kernel: notebook.metadata.kernelspec?.display_name,
    language: notebook.metadata.language_info?.name,
    cellCount: notebook.cells.length,
    cells: parsedCells,
  };
}

/**
 * Get a specific cell from a notebook
 */
export async function getCell(
  notebookPath: string,
  cellIndex: number
): Promise<ParsedCell> {
  const notebook = await readNotebook(notebookPath);

  if (cellIndex < 0 || cellIndex >= notebook.cellCount) {
    throw new Error(
      `Invalid cell index: ${cellIndex}. Notebook has ${notebook.cellCount} cells (0-${notebook.cellCount - 1}).`
    );
  }

  return notebook.cells[cellIndex];
}

// ============================================
// Notebook Editing
// ============================================

/**
 * Load raw notebook JSON
 */
async function loadNotebook(notebookPath: string): Promise<{
  notebook: Notebook;
  absolutePath: string;
}> {
  const absolutePath = path.isAbsolute(notebookPath)
    ? notebookPath
    : path.join(process.cwd(), notebookPath);

  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Notebook not found: ${absolutePath}`);
  }

  const content = await fs.promises.readFile(absolutePath, "utf-8");
  const notebook: Notebook = JSON.parse(content);

  return { notebook, absolutePath };
}

/**
 * Save notebook to disk
 */
async function saveNotebook(
  absolutePath: string,
  notebook: Notebook
): Promise<void> {
  const content = JSON.stringify(notebook, null, 1);
  await fs.promises.writeFile(absolutePath, content, "utf-8");
}

/**
 * Edit a cell's source code
 */
export async function editCell(
  notebookPath: string,
  cellIndex: number,
  newSource: string
): Promise<{ success: boolean; path: string; cellIndex: number }> {
  const { notebook, absolutePath } = await loadNotebook(notebookPath);

  if (cellIndex < 0 || cellIndex >= notebook.cells.length) {
    throw new Error(
      `Invalid cell index: ${cellIndex}. Notebook has ${notebook.cells.length} cells (0-${notebook.cells.length - 1}).`
    );
  }

  // Update the cell source (convert to array of lines for standard format)
  const sourceLines = newSource.split("\n").map((line, i, arr) =>
    i < arr.length - 1 ? line + "\n" : line
  );
  notebook.cells[cellIndex].source = sourceLines;

  // Clear outputs for code cells when source changes
  if (notebook.cells[cellIndex].cell_type === "code") {
    notebook.cells[cellIndex].outputs = [];
    notebook.cells[cellIndex].execution_count = null;
  }

  await saveNotebook(absolutePath, notebook);

  return {
    success: true,
    path: absolutePath,
    cellIndex,
  };
}

/**
 * Insert a new cell after a given index
 */
export async function insertCell(
  notebookPath: string,
  afterIndex: number,
  cellType: "code" | "markdown" | "raw",
  source: string
): Promise<{ success: boolean; path: string; newCellIndex: number }> {
  const { notebook, absolutePath } = await loadNotebook(notebookPath);

  // Allow inserting at the beginning (-1) or after any existing cell
  if (afterIndex < -1 || afterIndex >= notebook.cells.length) {
    throw new Error(
      `Invalid afterIndex: ${afterIndex}. Use -1 to insert at beginning, or 0-${notebook.cells.length - 1}.`
    );
  }

  // Create new cell
  const sourceLines = source.split("\n").map((line, i, arr) =>
    i < arr.length - 1 ? line + "\n" : line
  );

  const newCell: NotebookCell = {
    cell_type: cellType,
    source: sourceLines,
    metadata: {},
  };

  // Add code-specific properties
  if (cellType === "code") {
    newCell.execution_count = null;
    newCell.outputs = [];
  }

  // Generate a unique ID if notebook uses cell IDs (nbformat >= 4.5)
  if (notebook.nbformat >= 4 && notebook.nbformat_minor >= 5) {
    newCell.id = generateCellId();
  }

  // Insert the cell
  const insertIndex = afterIndex + 1;
  notebook.cells.splice(insertIndex, 0, newCell);

  await saveNotebook(absolutePath, notebook);

  return {
    success: true,
    path: absolutePath,
    newCellIndex: insertIndex,
  };
}

/**
 * Delete a cell from the notebook
 */
export async function deleteCell(
  notebookPath: string,
  cellIndex: number
): Promise<{ success: boolean; path: string; deletedIndex: number; remainingCells: number }> {
  const { notebook, absolutePath } = await loadNotebook(notebookPath);

  if (cellIndex < 0 || cellIndex >= notebook.cells.length) {
    throw new Error(
      `Invalid cell index: ${cellIndex}. Notebook has ${notebook.cells.length} cells (0-${notebook.cells.length - 1}).`
    );
  }

  // Don't allow deleting the last cell
  if (notebook.cells.length === 1) {
    throw new Error("Cannot delete the last cell in a notebook.");
  }

  // Remove the cell
  notebook.cells.splice(cellIndex, 1);

  await saveNotebook(absolutePath, notebook);

  return {
    success: true,
    path: absolutePath,
    deletedIndex: cellIndex,
    remainingCells: notebook.cells.length,
  };
}

/**
 * Move a cell to a new position
 */
export async function moveCell(
  notebookPath: string,
  fromIndex: number,
  toIndex: number
): Promise<{ success: boolean; path: string; fromIndex: number; toIndex: number }> {
  const { notebook, absolutePath } = await loadNotebook(notebookPath);

  if (fromIndex < 0 || fromIndex >= notebook.cells.length) {
    throw new Error(
      `Invalid fromIndex: ${fromIndex}. Notebook has ${notebook.cells.length} cells.`
    );
  }

  if (toIndex < 0 || toIndex >= notebook.cells.length) {
    throw new Error(
      `Invalid toIndex: ${toIndex}. Notebook has ${notebook.cells.length} cells.`
    );
  }

  if (fromIndex === toIndex) {
    return { success: true, path: absolutePath, fromIndex, toIndex };
  }

  // Remove cell from old position and insert at new position
  const [cell] = notebook.cells.splice(fromIndex, 1);
  notebook.cells.splice(toIndex, 0, cell);

  await saveNotebook(absolutePath, notebook);

  return {
    success: true,
    path: absolutePath,
    fromIndex,
    toIndex,
  };
}

/**
 * Change a cell's type
 */
export async function changeCellType(
  notebookPath: string,
  cellIndex: number,
  newType: "code" | "markdown" | "raw"
): Promise<{ success: boolean; path: string; cellIndex: number; newType: string }> {
  const { notebook, absolutePath } = await loadNotebook(notebookPath);

  if (cellIndex < 0 || cellIndex >= notebook.cells.length) {
    throw new Error(
      `Invalid cell index: ${cellIndex}. Notebook has ${notebook.cells.length} cells.`
    );
  }

  const cell = notebook.cells[cellIndex];
  const oldType = cell.cell_type;

  if (oldType === newType) {
    return { success: true, path: absolutePath, cellIndex, newType };
  }

  // Update cell type
  cell.cell_type = newType;

  // Handle type-specific properties
  if (newType === "code") {
    cell.execution_count = null;
    cell.outputs = [];
  } else {
    // Remove code-specific properties for non-code cells
    delete cell.execution_count;
    delete cell.outputs;
  }

  await saveNotebook(absolutePath, notebook);

  return {
    success: true,
    path: absolutePath,
    cellIndex,
    newType,
  };
}

/**
 * Clear all outputs in a notebook
 */
export async function clearAllOutputs(
  notebookPath: string
): Promise<{ success: boolean; path: string; clearedCells: number }> {
  const { notebook, absolutePath } = await loadNotebook(notebookPath);

  let clearedCount = 0;
  for (const cell of notebook.cells) {
    if (cell.cell_type === "code") {
      cell.outputs = [];
      cell.execution_count = null;
      clearedCount++;
    }
  }

  await saveNotebook(absolutePath, notebook);

  return {
    success: true,
    path: absolutePath,
    clearedCells: clearedCount,
  };
}

// ============================================
// Utilities
// ============================================

/**
 * Generate a unique cell ID (8 character hex string)
 */
function generateCellId(): string {
  const chars = "0123456789abcdef";
  let id = "";
  for (let i = 0; i < 8; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

/**
 * Create a new empty notebook
 */
export async function createNotebook(
  notebookPath: string,
  language: string = "python"
): Promise<{ success: boolean; path: string }> {
  const absolutePath = path.isAbsolute(notebookPath)
    ? notebookPath
    : path.join(process.cwd(), notebookPath);

  if (fs.existsSync(absolutePath)) {
    throw new Error(`Notebook already exists: ${absolutePath}`);
  }

  const notebook: Notebook = {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      kernelspec: {
        display_name: language === "python" ? "Python 3" : language,
        language: language,
        name: language === "python" ? "python3" : language,
      },
      language_info: {
        name: language,
      },
    },
    cells: [
      {
        id: generateCellId(),
        cell_type: "code",
        source: [],
        metadata: {},
        execution_count: null,
        outputs: [],
      },
    ],
  };

  // Ensure directory exists
  const dir = path.dirname(absolutePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  await saveNotebook(absolutePath, notebook);

  return {
    success: true,
    path: absolutePath,
  };
}

/**
 * Get notebook summary (for token-efficient exploration)
 */
export async function getNotebookSummary(notebookPath: string): Promise<{
  path: string;
  kernel?: string;
  language?: string;
  cellCount: number;
  codeCells: number;
  markdownCells: number;
  cellSummaries: Array<{
    index: number;
    type: string;
    lines: number;
    hasOutput: boolean;
    preview: string;
  }>;
}> {
  const notebook = await readNotebook(notebookPath);

  const cellSummaries = notebook.cells.map((cell) => {
    const lines = cell.source.split("\n").length;
    const preview = cell.source.slice(0, 100) + (cell.source.length > 100 ? "..." : "");

    return {
      index: cell.index,
      type: cell.type,
      lines,
      hasOutput: cell.outputs.length > 0,
      preview: preview.replace(/\n/g, " "),
    };
  });

  return {
    path: notebook.path,
    kernel: notebook.kernel,
    language: notebook.language,
    cellCount: notebook.cellCount,
    codeCells: notebook.cells.filter((c) => c.type === "code").length,
    markdownCells: notebook.cells.filter((c) => c.type === "markdown").length,
    cellSummaries,
  };
}
