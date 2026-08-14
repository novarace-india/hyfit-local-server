import { createParamDecorator, ExecutionContext } from '@nestjs/common';

// Reads the athlete id attached by HfgAthleteGuard.
export const HfgAthleteId = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string =>
    ctx.switchToHttp().getRequest().hfgAthleteId,
);

// Reads the admin id attached by HfgAdminGuard.
export const HfgAdminId = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string =>
    ctx.switchToHttp().getRequest().hfgAdminId,
);
