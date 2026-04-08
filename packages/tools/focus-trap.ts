/**
 * Focus trap utility for modal dialogs.
 */
export class FocusTrap {
  /**
   * @param count Number of focusable elements.
   * @param wrapAround Whether to wrap around when reaching boundaries.
   */
  constructor(public count: number, public wrapAround: boolean = true) {}

  /**
   * Get next focusable index.
   * @param currentIndex Current index.
   * @returns Next index or -1 if no next element.
   */
  next(currentIndex: number): number {
    if (currentIndex >= this.count - 1) {
      return this.wrapAround ? 0 : -1;
    }
    return currentIndex + 1;
  }

  /**
   * Get previous focusable index.
   * @param currentIndex Current index.
   * @returns Previous index or -1 if no previous element.
   */
  prev(currentIndex: number): number {
    if (currentIndex <= 0) {
      return this.wrapAround ? this.count - 1 : -1;
    }
    return currentIndex - 1;
  }

  /**
   * Get first focusable index.
   * @returns 0.
   */
  first(): number {
    return 0;
  }

  /**
   * Get last focusable index.
   * @returns Last index.
   */
  last(): number {
    return this.count - 1;
  }
}