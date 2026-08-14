import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { HjudgeUser } from './hjudge-auth.guard';

export const HjudgeUserParam = createParamDecorator(
  (data: keyof HjudgeUser | undefined, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest();
    const user: HjudgeUser = request.hjudgeUser;
    return data ? user?.[data] : user;
  },
);
