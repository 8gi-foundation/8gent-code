/**
 * Represents a column in the Kanban board.
 */
interface Column {
  name: string;
  wipLimit: number;
  cardIds: string[];
}

/**
 * Represents a card on the Kanban board.
 */
interface Card {
  id: string;
  history: string[];
  completionDate?: number;
}

/**
 * Represents the Kanban board.
 */
interface Board {
  columns: Column[];
  cards: { [id: string]: Card };
}

/**
 * Creates a new Kanban board with specified columns and WIP limits.
 * @param columns Array of column names.
 * @param wipLimits Object mapping column names to WIP limits.
 * @returns The new board.
 */
export function createBoard(columns: string[], wipLimits: { [key: string]: number }): Board {
  return {
    columns: columns.map(col => ({
      name: col,
      wipLimit: wipLimits[col] || 0,
      cardIds: []
    })),
    cards: {}
  };
}

/**
 * Moves a card to a new column, throwing if WIP limit is exceeded.
 * @param board The board.
 * @param cardId The card ID.
 * @param toColumn The target column name.
 */
export function moveCard(board: Board, cardId: string, toColumn: string): void {
  const card = board.cards[cardId];
  if (!card) {
    throw new Error('Card not found');
  }
  const currentColumn = card.history[card.history.length - 1];
  const fromIndex = board.columns.findIndex(col => col.name === currentColumn);
  const toIndex = board.columns.findIndex(col => col.name === toColumn);
  if (fromIndex === -1 || toIndex === -1) {
    throw new Error('Invalid column');
  }
  const fromCol = board.columns[fromIndex];
  const toCol = board.columns[toIndex];
  const cardIndex = fromCol.cardIds.indexOf(cardId);
  if (cardIndex === -1) {
    throw new Error('Card not in current column');
  }
  fromCol.cardIds.splice(cardIndex, 1);
  toCol.cardIds.push(cardId);
  if (toCol.cardIds.length > toCol.wipLimit) {
    toCol.cardIds.pop();
    throw new Error('WIP limit exceeded');
  }
  card.history.push(toColumn);
  if (toColumn === 'Done') {
    card.completionDate = Date.now();
  }
}

/**
 * Returns columns that are at their WIP limit.
 * @param board The board.
 * @returns Array of column names at WIP limit.
 */
export function getBlockedColumns(board: Board): string[] {
  return board.columns
    .filter(col => col.cardIds.length === col.wipLimit)
    .map(col => col.name);
}

/**
 * Calculates cycle time for a card (days from first move to Done).
 * @param card The card.
 * @returns Cycle time in days.
 */
export function cycleTime(card: Card): number {
  const doneIndex = card.history.lastIndexOf('Done');
  return doneIndex !== -1 ? doneIndex : 0;
}

/**
 * Calculates throughput (cards completed per day over last N days).
 * @param board The board.
 * @param days Number of days to consider.
 * @returns Throughput as cards per day.
 */
export function throughput(board: Board, days: number): number {
  const now = Date.now();
  const cutoff = now - days * 24 * 60 * 60 * 1000;
  let count = 0;
  for (const card of Object.values(board.cards)) {
    if (card.completionDate && card.completionDate >= cutoff) {
      count++;
    }
  }
  return count / days;
}

/**
 * Renders the board as an ASCII representation with card counts.
 * @param board The board.
 * @returns ASCII string of the board.
 */
export function renderBoard(board: Board): string {
  return board.columns
    .map(col => `${col.name.padEnd(15)} | ${col.cardIds.length}`)
    .join('\n');
}