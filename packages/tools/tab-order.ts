/**
 * Tab order manager.
 */
export class TabOrder {
  private order: string[] = [];
  
  /**
   * Adds an element to the tab order.
   * @param id - Element ID.
   * @param after - Insert after this ID.
   */
  add(id: string, after?: string): void {
    if (this.order.includes(id)) return;
    if (after) {
      const afterIndex = this.order.indexOf(after);
      if (afterIndex !== -1) {
        this.order.splice(afterIndex + 1, 0, id);
      } else {
        this.order.push(id);
      }
    } else {
      this.order.push(id);
    }
  }
  
  /**
   * Removes an element from the tab order.
   * @param id - Element ID.
   */
  remove(id: string): void {
    const index = this.order.indexOf(id);
    if (index !== -1) {
      this.order.splice(index, 1);
    }
  }
  
  /**
   * Returns next element ID in tab order.
   * @param id - Current element ID.
   * @returns Next ID or undefined.
   */
  next(id: string): string | undefined {
    const index = this.order.indexOf(id);
    return index !== -1 && index + 1 < this.order.length ? this.order[index + 1] : undefined;
  }
  
  /**
   * Returns previous element ID in tab order.
   * @param id - Current element ID.
   * @returns Previous ID or undefined.
   */
  prev(id: string): string | undefined {
    const index = this.order.indexOf(id);
    return index !== -1 && index > 0 ? this.order[index - 1] : undefined;
  }
}