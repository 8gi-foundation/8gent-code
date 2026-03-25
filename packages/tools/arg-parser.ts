/**
 * Definition for a CLI flag with type, default value, and alias.
 */
interface FlagDefinition {
  name: string;
  type: 'string' | 'boolean' | 'number';
  default: any;
  alias?: string;
}

/**
 * CLI argument parser with typed flags, positional args, and help generation.
 */
export class ArgumentParser {
  private programName: string;
  private flags: FlagDefinition[];
  private flagMap: Map<string, FlagDefinition>;

  /**
   * @param programName Name of the program for help messages
   * @param flags Array of flag definitions
   */
  constructor(programName: string, flags: FlagDefinition[]) {
    this.programName = programName;
    this.flags = flags;
    this.flagMap = new Map();
    for (const flag of flags) {
      this.flagMap.set(flag.name, flag);
      if (flag.alias) this.flagMap.set(flag.alias, flag);
    }
  }

  /**
   * Parse command line arguments into a typed object.
   * @param argv Array of command line arguments (process.argv)
   * @returns Parsed arguments with flags and positional args in `_`
   * @throws Error if unknown flag is encountered
   */
  parse(argv: string[]): any {
    const result: any = { _: [] };
    let i = 0;

    while (i < argv.length) {
      const arg = argv[i];
      if (!arg.startsWith('--')) {
        result._.push(arg);
        i++;
        continue;
      }

      const flagName = arg.slice(2);
      const flag = this.flagMap.get(flagName);

      if (!flag) {
        const suggestion = this.findClosestFlag(flagName);
        throw new Error(`Unknown flag: ${flagName}${suggestion ? ` Did you mean ${suggestion}?` : ''}`);
      }

      i++;
      let value: any;

      if (i < argv.length && !argv[i].startsWith('--')) {
        value = argv[i++];
      } else {
        value = flag.type === 'boolean' ? true : flag.default;
      }

      switch (flag.type) {
        case 'string':
          result[flag.name] = value === undefined ? flag.default : value;
          break;
        case 'number':
          result[flag.name] = isNaN(Number(value)) ? flag.default : Number(value);
          break;
        case 'boolean':
          result[flag.name] = value !== undefined ? value : flag.default;
          break;
      }
    }

    for (const flag of this.flags) {
      if (!(flag.name in result)) {
        result[flag.name] = flag.default;
      }
    }

    return result;
  }

  /**
   * Generate help message for the CLI program.
   * @returns Formatted help string
   */
  generateHelp(): string {
    const lines = [
      `Usage: ${this.programName} [flags] [positional args]`,
      '',
      'Flags:'
    ];

    for (const flag of this.flags) {
      const alias = flag.alias ? ` (${flag.alias})` : '';
      const defaultValue = flag.default !== undefined ? ` (default: ${flag.default})` : '';
      lines.push(`  --${flag.name}${alias}: ${flag.type}${defaultValue}`);
    }

    return lines.join('\n');
  }

  private findClosestFlag(flagName: string): string | undefined {
    let closest: string | undefined;
    let maxOverlap = 0;

    for (const flag of this.flags) {
      const name = flag.alias || flag.name;
      const overlap = this.overlap(flagName, name);
      if (overlap > maxOverlap) {
        maxOverlap = overlap;
        closest = name;
      }
    }

    return maxOverlap > 0 ? closest : undefined;
  }

  private overlap(a: string, b: string): number {
    const minLen = Math.min(a.length, b.length);
    let count = 0;
    for (let i = 0; i < minLen; i++) {
      if (a[i] === b[i]) count++;
    }
    return count;
  }
}