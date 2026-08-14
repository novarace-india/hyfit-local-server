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
import { HjudgeCheckinAuthGuard } from '../hjudge-auth.guard';
import type { HjudgeUser } from '../hjudge-auth.guard';

/* Check-in's own door.
 *
 * The counter is a different job from judging — different people, different
 * shifts, often the same borrowed tablet — so it signs in here, into its own
 * cookie, and only roles cleared for check-in get through. Judging is untouched
 * by anything that happens on this controller, and a device can hold both
 * sessions at once. */
@Controller('hyfit-judge/checkin/auth')
export class HjudgeCheckinAuthController {
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
    const isNativeClient =
      String(req.headers['x-hyfit-client'] ?? '').toLowerCase() === 'native';
    return this.authService.login(
      staffId,
      pin,
      body.deviceLabel ?? '',
      ip,
      res,
      isNativeClient,
      'checkin',
    );
  }

  @Post('logout')
  @HttpCode(200)
  @UseGuards(HjudgeCheckinAuthGuard)
  async logout(
    @HjudgeUserParam() user: HjudgeUser,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.authService.logout(user, res, 'checkin');
  }

  @Get('session')
  @UseGuards(HjudgeCheckinAuthGuard)
  getSession(@HjudgeUserParam() user: HjudgeUser) {
    return this.authService.getSession(user);
  }

  // A counter shift outlasts the 12-hour window on a multi-day event the same
  // way a judging shift does.
  @Post('refresh')
  @HttpCode(200)
  @UseGuards(HjudgeCheckinAuthGuard)
  async refresh(@HjudgeUserParam() user: HjudgeUser) {
    return this.authService.refresh(user);
  }
}
