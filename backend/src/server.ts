import 'dotenv/config';
import { NestFactory, Reflector } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe, ClassSerializerInterceptor } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import compression from 'compression';
import express from 'express';
import {
  HYFIT_LOCAL_UPLOAD_ROUTE,
  hyfitLocalUploadRoot,
} from './common/storage/s3.service';
import { TimingInterceptor } from './common/interceptors/timing.interceptor';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';

// Mirrors the Novarace bootstrap so the wire format the HYFIT frontend reads is
// byte-for-byte the same: the `api` global prefix, and the ResponseInterceptor /
// GlobalExceptionFilter pair with their /api/hyfit-judge/ carve-outs — judge and
// check-in read handler payloads directly, while the athlete and admin clients
// expect the { statusCode, status, data } envelope. Changing either side here
// would break one of the two clients silently.
export async function bootstrap() {
  const app = await NestFactory.create(AppModule, { rawBody: true });

  app.setGlobalPrefix('api');

  app.use(compression());

  app.use(
    helmet({
      hsts: {
        maxAge: 31536000,
        includeSubDomains: true,
        preload: true,
      },
      referrerPolicy: {
        policy: 'strict-origin-when-cross-origin',
      },
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          scriptSrc: ["'self'"],
          imgSrc: ["'self'", 'data:', 'https:'],
        },
      },
    }),
  );

  /* Uploaded files, served back off this laptop's own disk.
   *
   * The prod deployment has an S3 bucket behind a CDN and this one has a
   * folder; `S3Service` in this build writes to that folder and returns a URL
   * under this route, so the two halves have to agree on the path — which is
   * why it is a constant shared with the service rather than a string written
   * twice.
   *
   * OUTSIDE THE `api` PREFIX ON PURPOSE. These are assets, not endpoints: a
   * certificate background is fetched by an <img> tag, and putting it behind
   * the API prefix would file it with the routes that carry an envelope and a
   * guard. `fallthrough: false` so a missing file is a 404 from here rather
   * than falling through to the Nest router and coming back as a confusing
   * "Cannot GET".
   */
  app.use(
    HYFIT_LOCAL_UPLOAD_ROUTE,
    express.static(hyfitLocalUploadRoot, {
      fallthrough: false,
      index: false,
      maxAge: '1h',
    }),
  );

  app.use(cookieParser());
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(new GlobalExceptionFilter());
  app.useGlobalInterceptors(new ClassSerializerInterceptor(app.get(Reflector)));
  app.useGlobalInterceptors(new ResponseInterceptor());
  app.useGlobalInterceptors(new TimingInterceptor());
  app.useGlobalInterceptors(new LoggingInterceptor());

  // Keep-alive has to outlast the caller's, or the caller eats the race.
  //
  // Every browser request reaches this server through the Next rewrite proxy,
  // which holds a pool of keep-alive sockets to it. Node closes an idle socket
  // after five seconds by default; a proxy that dispatches onto one in that
  // instant sends a request nobody will answer, and the only trace is
  // `ECONNRESET — socket hang up` on the caller with nothing at all logged
  // here. The roster upload hit it because the admin screen sits idle while
  // the mapping is filled in, so the pull is always the first request after a
  // pause — the exact shape the race needs.
  //
  // Sixty-five seconds is longer than any proxy or load balancer in front of
  // this app keeps its own side open, so the far end is always the one that
  // closes first and retries cleanly. `headersTimeout` must stay above it:
  // it bounds the wait for a request's headers, and dropping below the
  // keep-alive window would expire live connections mid-handshake.
  const server = app.getHttpServer();
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  await app.listen(process.env.PORT ?? 3001);
}
