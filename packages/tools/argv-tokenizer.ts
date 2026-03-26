/**
 * Tokenizes a shell command string into an argv array.
 * @param cmd - The shell command string.
 * @returns A string array representing the tokenized command.
 */
export function tokenize(cmd: string): string[] {
  const tokens: string[] = [];
  let currentToken = '';
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let i = 0;

  while (i < cmd.length) {
    const char = cmd[i];

    if (inSingleQuote) {
      if (char === "'") {
        inSingleQuote = false;
        currentToken += char;
        tokens.push(currentToken);
        currentToken = '';
      } else if (char === '\\') {
        if (i + 1 < cmd.length) {
          currentToken += cmd[++i];
        }
      } else {
        currentToken += char;
      }
      i++;
    } else if (inDoubleQuote) {
      if (char === '"') {
        inDoubleQuote = false;
        currentToken += char;
        tokens.push(currentToken);
        currentToken = '';
      } else if (char === '\\') {
        if (i + 1 < cmd.length) {
          currentToken += cmd[++i];
        }
      } else if (char === '$') {
        currentToken += char;
      } else {
        currentToken += char;
      }
      i++;
    } else {
      if (char === ' ') {
        if (currentToken !== '') {
          tokens.push(currentToken);
          currentToken = '';
        }
      } else if (char === "'") {
        inSingleQuote = true;
        currentToken += char;
      } else if (char === '"') {
        inDoubleQuote = true;
        currentToken += char;
      } else if (char === '$') {
        let varStart = i + 1;
        if (varStart < cmd.length && cmd[varStart] === '{') {
          varStart++;
          let varEnd = cmd.indexOf('}', varStart);
          if (varEnd !== -1) {
            currentToken += cmd.slice(i, varEnd + 1);
            i = varEnd;
          } else {
            currentToken += char;
          }
        } else {
          let j = varStart;
          while (j < cmd.length && /[a-zA-Z0-9_]/.test(cmd[j])) {
            j++;
          }
          currentToken += cmd.slice(i, j);
          i = j - 1;
        }
        i++;
      } else {
        currentToken += char;
      }
      i++;
    }
  }

  if (currentToken !== '') {
    tokens.push(currentToken);
  }

  return tokens;
}