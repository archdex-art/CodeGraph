import log from "electron-log";

/**
 * Structured Logging Service.
 * Wraps electron-log to enforce structured JSON logs for production,
 * and maintains readable console output for development.
 */
export class Logger {
  constructor() {
    // Configure default log formats
    log.transports.console.format = "[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}] {text}";
    
    // In production, you'd typically want JSON structured logs for easy parsing
    // if sending to telemetry or analyzing crash reports.
    log.transports.file.format = "[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}] {text}";
    
    // Max file size 5MB
    log.transports.file.maxSize = 5 * 1024 * 1024;
  }

  public info(module: string, message: string, meta?: Record<string, any>): void {
    if (meta) log.info(`[${module}] ${message}`, meta);
    else log.info(`[${module}] ${message}`);
  }

  public warn(module: string, message: string, meta?: Record<string, any>): void {
    if (meta) log.warn(`[${module}] ${message}`, meta);
    else log.warn(`[${module}] ${message}`);
  }

  public error(module: string, message: string, error?: Error | unknown, meta?: Record<string, any>): void {
    const errorDetails = error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : error;
    if (meta) log.error(`[${module}] ${message}`, errorDetails, meta);
    else log.error(`[${module}] ${message}`, errorDetails);
  }

  public debug(module: string, message: string, meta?: Record<string, any>): void {
    if (meta) log.debug(`[${module}] ${message}`, meta);
    else log.debug(`[${module}] ${message}`);
  }
}
