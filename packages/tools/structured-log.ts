/**
 * Log level enumeration
 */
export enum Level {
  debug = 0,
  info = 1,
  warn = 2,
  error = 3,
}

/**
 * Transport function type
 */
export type Transport = (log: Log) => void;

/**
 * Log message structure
 */
export interface Log {
  level: Level;
  message: string;
  timestamp: string;
  [key: string]: any;
}

/**
 * Structured JSON logger with context and level filtering
 */
export class Logger {
  private context: Record<string, any>;
  private currentLevel: Level;
  private transport: Transport;

  /**
   * Create a new logger
   * @param context Initial context fields
   * @param currentLevel Minimum log level
   * @param transport Output handler
   */
  constructor(
    context: Record<string, any> = {},
    currentLevel: Level = Level.info,
    transport: Transport = (log) => console.log(log)
  ) {
    this.context = context;
    this.currentLevel = currentLevel;
    this.transport = transport;
  }

  /**
   * Create a child logger with merged context
   * @param fields Context fields to merge
   * @returns New Logger instance
   */
  withContext(fields: Record<string, any>): Logger {
    return new Logger({ ...this.context, ...fields }, this.current位, this.transport);
  }

  /**
   * Set the minimum log level
   * @param level Log level
   */
  setLevel(level: Level): void {
    this.currentLevel = level;
  }

  /**
   * Set the transport function
   * @param transport Function to handle log output
   */
  setTransport(transport: Transport): void {
    this.transport = transport;
  }

  /**
   * Log a debug message
   * @param message Message to log
   */
  debug(message: string): void {
    this.log(Level.debug, message);
  }

  /**
   * Log an info message
   * @param message Message to log
   */
  info(message: string): void {
    this.log(Level.info, message);
  }

  /**
   * Log a warning message
   * @param message Message to log
   */
  warn(message: string): void {
    this.log(Level.warn, message);
  }

  /**
   * Log an error message
   * @param message Message to log
   */
  error(message: string): void {
    this.log(Level.error, message);
  }

  private log(level: Level, message: string): void {
    if (Level[level] < Level[this.currentLevel]) {
      return;
    }
    const log: Log = {
      level,
      message,
      timestamp: new Date().toISOString(),
      ...this.context,
    };
    this.transport(log);
  }
}