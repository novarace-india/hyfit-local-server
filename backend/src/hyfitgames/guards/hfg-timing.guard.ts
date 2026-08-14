import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { hfgConfig } from '../hfg.config';

// API-key auth for the RaceResult14 timing push endpoints (x-api-key header),
// NOT JWT. Mirrors the original module's timingAuth middleware.
@Injectable()
export class HfgTimingGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const key = req.headers['x-api-key'];
    const expected = hfgConfig.timingApiKey;
    if (!expected) {
      throw new ServiceUnavailableException('Timing endpoint not configured');
    }
    if (!key || key !== expected) {
      throw new UnauthorizedException('Invalid or missing x-api-key header');
    }
    return true;
  }
}
