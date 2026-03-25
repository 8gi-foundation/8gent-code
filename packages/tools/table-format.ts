/**
 * Formats 2D data as an aligned ASCII table for terminal output.
 * @param rows - 2D array of strings representing table rows.
 * @param options - Optional configuration for table formatting.
 * @returns Formatted ASCII table as a string.
 */
export function table(rows: string[][], options?: { align?: ('left' | 'right' | 'center')[], header?: boolean, maxColumnWidth?: number, box?: boolean }): string {
  const { align = Array(rows[0]?.length).fill('left'), header = false, maxColumnWidth, box = false } = options || {};
  const columnWidths = rows.reduce((acc, row) => {
    row.forEach((cell, i) => acc[i] = Math.max(acc[i] || 0, cell.length));
    return acc;
  }, [] as number[]);
  if (maxColumnWidth) columnWidths.forEach((w, i) => columnWidths[i] = Math.min(w, maxColumnWidth));
  const lines: string[] = [];
  const separator = () => box ? '├' + columnWidths.map(w => '─'.repeat(w)).join('┼') + '┤' : ' | ' + columnWidths.map(() => '─'.repeat(maxColumnWidth || 10)).join(' | ');
  const border = box ? '┌' + columnWidths.map(w => '─'.repeat(w)).join('┬') + '┐' : ' ' + columnWidths.map(() => '─'.repeat(maxColumnWidth || 10)).join(' ') + ' ';
  const alignCell = (cell: string, width: number, align: 'left' | 'right' | 'center') => {
    switch (align) {
      case 'left': return cell.padEnd(width);
      case 'right': return cell.padStart(width);
      case 'center': {
        const pad = width - cell.length;
        return ' '.repeat(Math.floor(pad / 2)) + cell + ' '.repeat(Math.ceil(pad / 2));
      }
    }
  };
  const truncate = (cell: string, width: number) => {
    if (cell.length > width) return cell.substring(0, width - 3) + '...';
    return cell;
  };
  if (header) lines.push(separator());
  for (const [i, row] of rows.entries()) {
    const line = row.map((cell, j) => alignCell(truncate(cell, columnWidths[j]), columnWidths[j], align[j])).join(box ? '│' : ' | ');
    lines.push(line);
    if (header && i === 0) lines.push(separator());
  }
  if (box) lines.unshift(border);
  return lines.join('\n');
}