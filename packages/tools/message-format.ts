/**
 * Formats a template string with placeholders using ICU MessageFormat-style syntax.
 * @param template - The template string containing placeholders.
 * @param args - An object containing the values to interpolate.
 * @returns The formatted string with placeholders replaced.
 */
export function format(template: string, args: { [key: string]: any }): string {
  return template.replace(
    /{([^{}]+)(?:, (plural|select), ([^{}]+))?}/g,
    (match, varName, type, optionsStr) => {
      if (type) {
        const options = parseOptions(optionsStr);
        let selectedKey: string;

        if (type === 'plural') {
          const count = args[varName];
          selectedKey = getPluralKey(count);
        } else {
          selectedKey = args[varName] || 'other';
        }

        const selectedValue = options[selectedKey] || options['other'] || '';
        return format(selectedValue, args);
      } else {
        return args[varName] || '';
      }
    }
  );
}

/**
 * Parses options from a plural or select placeholder into a key-value map.
 * @param optionsStr - The options string from the placeholder.
 * @returns A map of option keys to their corresponding values.
 */
function parseOptions(optionsStr: string): { [key: string]: string } {
  const options: { [key: string]: string } = {};
  const parts = optionsStr.split(/\s+/);
  for (const part of parts) {
    const match = part.match(/^([^{}]+)\{([^{}]+)\}$/);
    if (match) {
      const key = match[1];
      const value = match[2];
      options[key] = value;
    }
  }
  return options;
}

/**
 * Determines the plural key based on the count value.
 * @param count - The count value to evaluate.
 * @returns The plural key ('zero', 'one', or 'other').
 */
function getPluralKey(count: any): string {
  if (count === 1) return 'one';
  if (count === 0) return 'zero';
  return 'other';
}