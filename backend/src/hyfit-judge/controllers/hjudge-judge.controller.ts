import {
  Controller,
  Get,
  Post,
  Body,
  Query,
  BadRequestException,
  NotFoundException,
  Logger,
  SetMetadata,
  UseGuards,
} from '@nestjs/common';
import { HjudgeJudgeService } from '../services/hjudge-judge.service';
import {
  HjudgeRaceSubmitService,
  type RaceSubmission,
} from '../services/hjudge-race-submit.service';
import { HjudgeUserParam } from '../hjudge-user.decorator';
import type { HjudgeUser } from '../hjudge-auth.guard';
import { HjudgeAuthGuard } from '../hjudge-auth.guard';
import { HjudgeRolesGuard, HJUDGE_ROLES_KEY } from '../hjudge-roles.guard';
import { judgeIdentity } from '../hjudge-session.util';

const JUDGE_ROLES = ['super_admin', 'event_admin', 'judge'];

/**
 * Four routes: find the athlete, take them, hand them back, hand in the race.
 *
 * The per-tap timing endpoint, the penalty endpoint and `finish` are gone —
 * they existed to keep a race on the server while it was being run, and the
 * tablet keeps it now and submits once.
 *
 * Claim and release came back, but not the table behind them: a hold is a
 * `judgedby` value on the athlete's own RaceResult record. See the note on
 * HjudgeJudgeService.
 */
@Controller('hyfit-judge/judge')
@UseGuards(HjudgeAuthGuard, HjudgeRolesGuard)
export class HjudgeJudgeController {
  private readonly logger = new Logger(HjudgeJudgeController.name);

  constructor(
    private readonly judgeService: HjudgeJudgeService,
    private readonly submitService: HjudgeRaceSubmitService,
  ) {}

  @Get('resolve')
  @SetMetadata(HJUDGE_ROLES_KEY, JUDGE_ROLES)
  async resolve(
    @HjudgeUserParam() user: HjudgeUser,
    @Query('code') code?: string,
  ) {
    if (!code)
      throw new BadRequestException(
        'A Wristband ID or Transponder ID is required',
      );
    const result = await this.judgeService.resolveWristband(
      user.eventId!,
      code,
      judgeIdentity(user),
    );
    if (!result)
      throw new NotFoundException(
        'No athlete is carrying this Wristband or Transponder ID',
      );
    return result;
  }

  /**
   * Takes the athlete. Writes this judge's staff ID to `judgedby`, having first
   * read the record fresh to see whether somebody else already has them.
   *
   * Re-claiming an athlete this judge already holds resumes rather than fails,
   * which is what a tablet that reloaded mid-race needs.
   */
  @Post('claim')
  @SetMetadata(HJUDGE_ROLES_KEY, JUDGE_ROLES)
  async claim(
    @Body()
    body: {
      // A scanned band or transponder.
      code?: string;
      wristband?: string;
      // Or the BIB the tablet already holds, from the roster. `participantId`
      // is the same thing under the name the app has always used for it — with
      // nothing stored, the roster's id IS the bib.
      bib?: string;
      participantId?: string;
      // Both bands of a doubles pair, scanned one after the other.
      wristbandCodes?: string[];
      readinessConfirmed?: boolean;
    },
    @HjudgeUserParam() user: HjudgeUser,
  ) {
    const pair = Array.isArray(body.wristbandCodes)
      ? body.wristbandCodes.map((v) => String(v ?? '').trim()).filter(Boolean)
      : [];

    if (pair.length) {
      if (body.readinessConfirmed !== true)
        throw new BadRequestException(
          'Confirm that both athletes are present and ready',
        );
      return this.judgeService.claimPair(user.eventId!, pair, judgeIdentity(user));
    }

    const code = String(body.code ?? body.wristband ?? '').trim();
    const bib = String(body.bib ?? body.participantId ?? '').trim();
    if (!code && !bib)
      throw new BadRequestException(
        'A Wristband ID, Transponder ID or BIB is required',
      );

    const claimed = await this.judgeService.claim(
      user.eventId!,
      { code, bib },
      judgeIdentity(user),
    );
    if (!claimed)
      throw new NotFoundException(
        code
          ? 'No athlete is carrying this Wristband or Transponder ID'
          : `BIB ${bib} was not found`,
      );
    return claimed;
  }

  /** Hands an athlete back without recording a race, clearing `judgedby`. */
  @Post('release')
  @SetMetadata(HJUDGE_ROLES_KEY, JUDGE_ROLES)
  async release(
    @Body() body: { bib?: string },
    @HjudgeUserParam() user: HjudgeUser,
  ) {
    const bib = String(body.bib ?? '').trim();
    if (!/^\d+$/.test(bib))
      throw new BadRequestException('A numeric BIB is required');
    return this.judgeService.release(user.eventId!, bib, judgeIdentity(user));
  }

  /**
   * The finished race. Scored here and written straight to RaceResult.
   *
   * Safe to repeat: every field is set rather than appended, so a tablet that
   * did not see the response can send the same race again.
   */
  @Post('results')
  @SetMetadata(HJUDGE_ROLES_KEY, JUDGE_ROLES)
  async submit(
    @Body() body: RaceSubmission,
    @HjudgeUserParam() user: HjudgeUser,
  ) {
    try {
      return await this.submitService.submit(
        user.eventId!,
        body,
        judgeIdentity(user),
      );
    } catch (error) {
      const status = (error as { status?: number }).status ?? 500;
      if (status === 500) {
        // The tablet gets a line it can act on; the log gets the reason.
        this.logger.error(
          `Race submit failed (event ${user.eventId}, judge ${user.id}): ${(error as Error).message}`,
          (error as Error).stack,
        );
        throw new BadRequestException(
          'The race could not be sent to RaceResult — try again',
        );
      }
      throw error;
    }
  }
}
