import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { verifyAccess } from '../hfg-jwt.util';

// Admin auth for HYFIT Games routes. Attaches `hfgAdminId` / `hfgAdminRole`.
// Mirrors the original module's authAdmin middleware.
@Injectable()
export class HfgAdminGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context
      .switchToHttp()
      .getRequest<Request & { hfgAdminId?: string; hfgAdminRole?: string }>();
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) throw new UnauthorizedException('Admin login required');
    try {
      const payload = await verifyAccess(token);
      if (payload.typ !== 'admin') throw new Error('wrong type');
      req.hfgAdminId = payload.sub;
      req.hfgAdminRole = payload.role;
      return true;
    } catch {
      throw new UnauthorizedException('Admin session expired');
    }
  }
}
