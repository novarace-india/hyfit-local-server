import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

@Injectable()
export class ResponseInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const request = context.switchToHttp().getRequest();

    // The hyfit-judge module is a self-contained port with its own frontend
    // that reads handler payloads directly (`{ user }`, `{ participant }`, …).
    // Wrapping them in the `{ statusCode, status, data }` envelope hides every
    // field one level down and silently breaks that client, so leave its
    // responses untouched — same carve-out the global guards make.
    if (request.url?.startsWith('/api/hyfit-judge/')) {
      return next.handle();
    }

    return next.handle().pipe(
      map((data) => {
        // If response is already properly structured with statusCode and status, return as-is
        if (
          data &&
          typeof data === 'object' &&
          'statusCode' in data &&
          'status' in data
        ) {
          return data;
        }

        // For responses that aren't properly structured, wrap them
        // Success responses should have data wrapper
        const response: any = {
          statusCode: 200,
          status: 'success',
          data: data,
        };

        return response;
      }),
    );
  }
}
