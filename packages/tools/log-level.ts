export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  silent: 4,
};

export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  setLevel(level: LogLevel): void;
}

export function createLogger(options: { level?: LogLevel; prefix?: string } = {}): Logger {
  let currentLevel: LogLevel = options.level ?? 'info';
  const prefix = options.prefix ? `[${options.prefix}]` : '';

  function shouldLog(level: LogLevel): boolean {
    return LEVEL_ORDER[level] >= LEVEL_ORDER[currentLevel];
  }

  function fmt(label: string, args: unknown[]): unknown[] {
    return prefix ? [prefix, label, ...args] : [label, ...args];
  }

  return {
    debug(...args: unknown[]): void {
      if (shouldLog('debug')) console.debug(...fmt('[debug]', args));
    },
    info(...args: unknown[]): void {
      if (shouldLog('info')) console.info(...fmt('[info]', args));
    },
    warn(...args: unknown[]): void {
      if (shouldLog('warn')) console.warn(...fmt('[warn]', args));
    },
    error(...args: unknown[]): void {
      if (shouldLog('error')) console.error(...fmt('[error]', args));
    },
    setLevel(level: LogLevel): void {
      currentLevel = level;
    },
  };
}
