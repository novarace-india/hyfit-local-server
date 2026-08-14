import { Injectable, NestMiddleware, Logger } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';

/** Priority: CORS_ALLOWED_ORIGINS (CSV), then PUBLIC_ORIGIN, then ADMIN_ORIGIN. Localhost/EB always allowed. */
function buildAllowedOrigins(): Set<string> {
  const origins = new Set<string>();

  const csv = process.env.CORS_ALLOWED_ORIGINS;
  if (csv) {
    csv
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean)
      .forEach((o) => origins.add(o));
  }

  if (process.env.PUBLIC_ORIGIN) origins.add(process.env.PUBLIC_ORIGIN);
  if (process.env.ADMIN_ORIGIN) origins.add(process.env.ADMIN_ORIGIN);

  return origins;
}

const normalise = (o: string) => o.replace(/\/+$/, '');
const ALLOWED_ORIGINS = buildAllowedOrigins();
const EB_REGEX = /^https?:\/\/.*\.elasticbeanstalk\.com$/;
const LOCALHOST_REGEX =
  /^https?:\/\/([a-zA-Z0-9-]+\.)?(localhost|127\.0\.0\.1|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)(:\d+)?$/;

@Injectable()
export class CorsMiddleware implements NestMiddleware {
  private readonly logger = new Logger(CorsMiddleware.name);

  use(req: Request, res: Response, next: NextFunction) {
    const originHeader = req.headers.origin;

    let allowedOrigin: string | undefined;

    if (originHeader) {
      const normalisedOrigin = normalise(originHeader);

      if (
        LOCALHOST_REGEX.test(normalisedOrigin) ||
        EB_REGEX.test(normalisedOrigin)
      ) {
        allowedOrigin = originHeader;
      } else if (ALLOWED_ORIGINS.has(normalisedOrigin)) {
        allowedOrigin = originHeader;
      } else {
        const matched = [...ALLOWED_ORIGINS].some((allowed) => {
          const domain = normalise(allowed).replace(/^https?:\/\//, '');
          return normalisedOrigin.replace(/^https?:\/\//, '') === domain;
        });
        if (matched) {
          allowedOrigin = originHeader;
        }
      }
    }

    // Non-browser requests (no origin header) get wildcard
    if (!allowedOrigin && !originHeader) {
      allowedOrigin = '*';
    }

    if (allowedOrigin) {
      res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
      res.setHeader('Vary', 'Origin');
    }

    res.setHeader(
      'Access-Control-Allow-Methods',
      'GET,POST,PATCH,DELETE,OPTIONS,PUT',
    );

    const requestHeaders = req.headers['access-control-request-headers'];
    if (requestHeaders) {
      res.setHeader('Access-Control-Allow-Headers', requestHeaders);
    } else {
      res.setHeader(
        'Access-Control-Allow-Headers',
        'Content-Type, Authorization, X-Request-ID, Accept, Origin, Cache-Control, X-Requested-With',
      );
    }

    // FIX #9: Credentials + wildcard cannot coexist (CORS spec: https://fetch.spec.whatwg.org/#cors-check)
    if (allowedOrigin !== '*') {
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    }

    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }

    next();
  }
}
