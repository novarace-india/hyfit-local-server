import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap, catchError } from 'rxjs/operators';
import { throwError } from 'rxjs';

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger(LoggingInterceptor.name);

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const req = context.switchToHttp().getRequest();
    const { method, url } = req;
    const now = Date.now();

    return next.handle().pipe(
      tap(() => {
        const delay = Date.now() - now;
        this.logger.log(`${method} ${url} 200 ${delay}ms`);
      }),
      catchError((error) => {
        const delay = Date.now() - now;
        const statusCode = error?.status || 500;
        const line = `${method} ${url} ${statusCode} ${delay}ms - ${error?.message || 'error'}`;
        // Same split as GlobalExceptionFilter: 4xx are expected/handled
        // client outcomes, not server malfunctions — don't log as `error`.
        if (statusCode >= 500) {
          this.logger.error(line);
        } else {
          this.logger.warn(line);
        }
        return throwError(() => error);
      }),
    );
  }
}
