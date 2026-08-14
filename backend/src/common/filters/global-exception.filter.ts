import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    let statusCode = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = 'Internal server error';

    // Handle NestJS HttpException
    if (exception instanceof HttpException) {
      statusCode = exception.getStatus();
      const exceptionResponse = exception.getResponse();

      // Extract message from exception response
      if (typeof exceptionResponse === 'object' && exceptionResponse !== null) {
        const errorObj = exceptionResponse as any;
        message = errorObj.message || exceptionResponse.toString();
        // Get first message if it's an array
        if (Array.isArray(errorObj.message)) {
          message = errorObj.message[0];
        }
      } else {
        message = exceptionResponse.toString();
      }
    } else if (exception instanceof Error) {
      // Handle generic Error
      message = exception.message;
      statusCode = HttpStatus.INTERNAL_SERVER_ERROR;
    }

    // Log the error (skip noisy favicon 404s entirely). 4xx responses are
    // expected/handled client-side outcomes (e.g. an anonymous visitor's
    // GET /auth/me returning 401) — log those at `warn`, not `error`, and
    // reserve `error` (with a stack trace) for genuine 5xx server failures.
    const isFavicon404 =
      statusCode === HttpStatus.NOT_FOUND &&
      typeof message === 'string' &&
      message.includes('favicon.ico');
    if (!isFavicon404) {
      if (statusCode >= 500) {
        this.logger.error(
          `[${statusCode}] ${message}`,
          exception instanceof Error ? exception.stack : '',
        );
      } else {
        this.logger.warn(`[${statusCode}] ${message}`);
      }
    }

    // Determine response status
    const status =
      statusCode >= 200 && statusCode < 300 ? 'success' : 'failure';

    // HTTP response status code:
    // - Return 200 for all successful (2xx) and client error requests (4xx)
    // - Only return 5xx for server errors
    const httpStatusCode = statusCode >= 500 ? statusCode : 200;

    // For 5xx errors, return generic message instead of exposing internal details
    const responseMessage =
      statusCode >= 500 ? 'Internal server error' : message;

    // The hyfit-judge client branches on `response.ok` and reads `error`.
    // Collapsing its 4xx to HTTP 200 (as the host app's convention does) makes
    // a rejected PIN look like a successful login with no user on it, so keep
    // the real status code and the `error` key for that module.
    const request = ctx.getRequest<Request>();
    if (request.url?.startsWith('/api/hyfit-judge/')) {
      // An HttpException's message was chosen by the code that threw it, so it
      // is safe to show and is usually the only actionable thing the operator
      // gets — "RaceResult participant endpoint returned HTTP 500" is the whole
      // point of a failed sync response. Scrubbing every 5xx to "Internal
      // server error" (right for an unexpected crash) would throw that away, so
      // only non-HttpException failures get the generic text here.
      const deliberate = exception instanceof HttpException;
      const judgeMessage = deliberate ? message : responseMessage;

      // Carry through any extra keys the thrower attached (e.g. the failed
      // sync's runId) instead of flattening the payload to message-only.
      const extra =
        deliberate &&
        typeof (exception as HttpException).getResponse() === 'object'
          ? { ...((exception as HttpException).getResponse() as object) }
          : {};
      delete (extra as Record<string, unknown>).message;
      delete (extra as Record<string, unknown>).error;
      delete (extra as Record<string, unknown>).statusCode;

      response.status(statusCode).json({
        ...extra,
        statusCode,
        status,
        error: judgeMessage,
        message: judgeMessage,
      });
      return;
    }

    // Send standardized error response with statusCode, status, and message ONLY
    response.status(httpStatusCode).json({
      statusCode,
      status,
      message: responseMessage,
    });
  }
}
