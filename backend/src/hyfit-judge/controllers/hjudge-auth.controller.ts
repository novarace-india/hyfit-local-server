import {
  Controller,
  Post,
  Get,
  Body,
  Req,
  Res,
  HttpCode,
  BadRequestException,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { HjudgeAuthService } from '../services/hjudge-auth.service';
import { HjudgeUserParam } from '../hjudge-user.decorator';
import { HjudgeAuthGuard } from '../hjudge-auth.guard';
import type { HjudgeUser } from '../hjudge-auth.guard';

@Controller('hyfit-judge/auth')
export class HjudgeAuthController {
  constructor(private readonly authService: HjudgeAuthService) {}

  @Post('login')
  async login(
    @Body() body: { staffId?: string; pin?: string; deviceLabel?: string },
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const staffId = String(body.staffId ?? '').trim();
    const pin = String(body.pin ?? '').trim();
    if (!staffId || !/^\d{4,8}$/.test(pin)) {
      throw new BadRequestException('Enter a valid staff ID and PIN');
    }
    const ip =
      (req.headers['x-forwarded-for'] as string) ??
      req.socket.remoteAddress ??
      '';
    // The iOS/Android app identifies itself here to receive the session token
    // in the response body. Browsers omit the header and keep using the
    // HttpOnly cookie, so nothing about the web login changes.
    const isNativeClient =
      String(req.headers['x-hyfit-client'] ?? '').toLowerCase() === 'native';
    return this.authService.login(
      staffId,
      pin,
      body.deviceLabel ?? '',
      ip,
      res,
      isNativeClient,
    );
  }

  // Lets a running app extend its own session before the 12-hour window
  // closes, so a multi-day event doesn't sign judges out mid-race.
  @Post('refresh')
  @HttpCode(200)
  @UseGuards(HjudgeAuthGuard)
  async refresh(@HjudgeUserParam() user: HjudgeUser) {
    return this.authService.refresh(user);
  }

  // Both routes read the caller's identity off the request, which only the
  // hyfit-judge session guard puts there — without it `user` is undefined and
  // the handler throws a 500 instead of the 401 the frontend expects.
  @Post('logout')
  @HttpCode(200)
  @UseGuards(HjudgeAuthGuard)
  async logout(
    @HjudgeUserParam() user: HjudgeUser,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.authService.logout(user, res);
  }

  @Get('session')
  @UseGuards(HjudgeAuthGuard)
  getSession(@HjudgeUserParam() user: HjudgeUser) {
    return this.authService.getSession(user);
  }
}
