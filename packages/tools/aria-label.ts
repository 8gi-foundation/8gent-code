/**
 * Generates an accessible ARIA label based on element context.
 * @param element - An object representing the element's properties.
 * @returns A descriptive label string.
 */
export function labelFor(element: { type: 'button' | 'input' | 'list'; text?: string; icon?: string; name?: string; required?: boolean; count?: number; noun?: string }): string {
  switch (element.type) {
    case 'button':
      return buttonLabel(element.text || '', element.icon);
    case 'input':
      return inputLabel(element.name || '', element.type, element.required || false);
    case 'list':
      return listLabel(element.count || 0, element.noun || '');
    default:
      return '';
  }
}

/**
 * Combines text and icon context for a button label.
 * @param text - The button's text.
 * @param icon - Optional icon name.
 * @returns A descriptive button label.
 */
export function buttonLabel(text: string, icon?: string): string {
  return icon ? `${text} (${icon} icon)` : text;
}

/**
 * Builds a form input label.
 * @param name - The input's name.
 * @param type - The input's type (e.g., 'text', 'email').
 * @param required - Whether the input is required.
 * @returns A descriptive input label.
 */
export function inputLabel(name: string, type: string, required: boolean): string {
  let label = `${name} (${type} input)`;
  if (required) {
    label += ' (required)';
  }
  return label;
}

/**
 * Builds a list item count label.
 * @param count - The number of items.
 * @param noun - The noun for the items.
 * @returns A label like 'N items'.
 */
export function listLabel(count: number, noun: string): string {
  return `${count} ${noun}${count !== 1 ? 's' : ''}`;
}