/**
 * Handles keyboard navigation for lists and grids.
 * @param event - Keyboard event
 * @param currentIndex - Current index in the list
 * @param itemCount - Total number of items
 * @param orientation - Navigation orientation: 'horizontal', 'vertical', or 'grid'
 * @returns New index after navigation
 */
function handleKey(
  event: KeyboardEvent,
  currentIndex: number,
  itemCount: number,
  orientation: 'horizontal' | 'vertical' | 'grid'
): number {
  const maxIndex = itemCount - 1;
  switch (event.key) {
    case 'ArrowUp':
      return Math.max(0, currentIndex - 1);
    case 'ArrowDown':
      return Math.min(maxIndex, currentIndex + 1);
    case 'ArrowLeft':
      return Math.max(0, currentIndex - 1);
    case 'ArrowRight':
      return Math.min(maxIndex, currentIndex + 1);
    case 'Home':
      return 0;
    case 'End':
      return maxIndex;
    case 'PageUp':
      return Math.max(0, currentIndex - 10);
    case 'PageDown':
      return Math.min(maxIndex, currentIndex + 10);
    default:
      return currentIndex;
  }
}

/**
 * Handles grid navigation based on key events.
 * @param event - Keyboard event
 * @param row - Current row
 * @param col - Current column
 * @param cols - Number of columns
 * @param rows - Number of rows
 * @returns New row and column
 */
function gridNav(
  event: KeyboardEvent,
  row: number,
  col: number,
  cols: number,
  rows: number
): { row: number; col: number } {
  switch (event.key) {
    case 'ArrowUp':
      return { row: Math.max(0, row - 1), col };
    case 'ArrowDown':
      return { row: Math.min(rows - 1, row + 1), col };
    case 'ArrowLeft':
      return { row, col: Math.max(0, col - 1) };
    case 'ArrowRight':
      return { row, col: Math.min(cols - 1, col + 1) };
    case 'Home':
      return { row, col: 0 };
    case 'End':
      return { row, col: cols - 1 };
    case 'PageUp':
      return { row: Math.max(0, row - 10), col };
    case 'PageDown':
      return { row: Math.min(rows - 1, row + 10), col };
    default:
      return { row, col };
  }
}

export { handleKey, gridNav };