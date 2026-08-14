import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { HjudgeUser } from './hjudge-auth.guard';

export const HJUDGE_ROLES_KEY = 'hjudge_roles';

@Injectable()
export class HjudgeRolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.get<string[]>(
      HJUDGE_ROLES_KEY,
      context.getHandler(),
    );
    if (!requiredRoles || requiredRoles.length === 0) return true;

    const request = context.switchToHttp().getRequest();
    const user: HjudgeUser | undefined = request.hjudgeUser;
    if (!user) throw new ForbiddenException('Not authenticated');

    if (!requiredRoles.includes(user.role)) {
      throw new ForbiddenException('Not authorized');
    }

    return true;
  }
}
