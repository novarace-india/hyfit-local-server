import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { verifyAccess } from '../hfg-jwt.util';

// Athlete auth for HYFIT Games routes. Reads a Bearer token, verifies it, and
// attaches `hfgAthleteId` to the request. Mirrors the original module's
// authAthlete middleware.
@Injectable()
export class HfgAthleteGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context
      .switchToHttp()
      .getRequest<Request & { hfgAthleteId?: string }>();
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) throw new UnauthorizedException('Login required');
    try {
      const payload = await verifyAccess(token);
      if (payload.typ !== 'athlete') throw new Error('wrong type');
      req.hfgAthleteId = payload.sub;
      return true;
    } catch {
      throw new UnauthorizedException('Session expired — please log in again');
    }
  }
}
