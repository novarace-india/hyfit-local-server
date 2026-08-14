import { Logger } from '@nestjs/common';

/**
 * Centralized logging utility for consistent error tracking across services
 * Logs to console and can be extended to send to external services (DataDog, Sentry, etc.)
 */
export class AppLogger {
  private static logger = new Logger('AppLogger');

  /**
   * Log error with full context
   * @param error The error object or string
   * @param context Information about where/what the error occurred
   * @param additionalData Any additional context data
   */
  static logError(
    error: any,
    context: string,
    additionalData?: Record<string, any>,
  ) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : '';

    const logData = {
      timestamp: new Date().toISOString(),
      context,
      error: errorMessage,
      stack: errorStack,
      ...(additionalData && { data: additionalData }),
    };

    this.logger.error(JSON.stringify(logData));

    // Future: Send to external monitoring service
    // this.sendToMonitoring(logData);
  }

  /**
   * Log warning
   */
  static logWarn(
    message: string,
    context: string,
    additionalData?: Record<string, any>,
  ) {
    const logData = {
      timestamp: new Date().toISOString(),
      context,
      message,
      ...(additionalData && { data: additionalData }),
    };

    this.logger.warn(JSON.stringify(logData));
  }

  /**
   * Log info/debug messages
   */
  static logInfo(
    message: string,
    context: string,
    additionalData?: Record<string, any>,
  ) {
    const logData = {
      timestamp: new Date().toISOString(),
      context,
      message,
      ...(additionalData && { data: additionalData }),
    };

    this.logger.log(JSON.stringify(logData));
  }

  /**
   * Log database errors with query details
   */
  static logDatabaseError(
    error: any,
    query: string,
    params?: any,
    additionalContext?: string,
  ) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : '';

    const logData = {
      timestamp: new Date().toISOString(),
      context: `DatabaseError${additionalContext ? ': ' + additionalContext : ''}`,
      error: errorMessage,
      stack: errorStack,
      query,
      ...(params && { queryParams: params }),
    };

    this.logger.error(JSON.stringify(logData));
  }
}
