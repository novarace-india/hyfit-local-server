import {
  Controller,
  Get,
  Post,
  Body,
  Query,
  BadRequestException,
  NotFoundException,
  SetMetadata,
  UseGuards,
} from '@nestjs/common';
import { HjudgeCheckinService } from '../services/hjudge-checkin.service';
import { HjudgeUserParam } from '../hjudge-user.decorator';
import type { HjudgeUser } from '../hjudge-auth.guard';
import { HjudgeCheckinAuthGuard } from '../hjudge-auth.guard';
import { HjudgeRolesGuard, HJUDGE_ROLES_KEY } from '../hjudge-roles.guard';
import { isCheckinStage } from '../hjudge-checkin-rr.util';

const COUNTER_ROLES = ['super_admin', 'event_admin', 'checkin'];

@Controller('hyfit-judge/checkin')
@UseGuards(HjudgeCheckinAuthGuard, HjudgeRolesGuard)
export class HjudgeCheckinController {
  constructor(private readonly checkinService: HjudgeCheckinService) {}

  @Get('participant')
  @SetMetadata(HJUDGE_ROLES_KEY, COUNTER_ROLES)
  async getParticipant(
    @HjudgeUserParam() user: HjudgeUser,
    @Query('bib') bib?: string,
    // `wristband` is what the app has always sent and stays supported;
    // `code` is the honest name for it now that a transponder resolves here
    // too. Same parameter, two spellings, so no client has to change.
    @Query('wristband') wristband?: string,
    @Query('code') code?: string,
  ) {
    if (bib) {
      if (!/^\d+$/.test(bib))
        throw new BadRequestException('A numeric BIB is required');
      const result = await this.checkinService.getParticipant(user.eventId!, {
        bib,
      });
      if (!result) throw new NotFoundException(`BIB ${bib} was not found`);
      return result;
    }

    const cleanCode = (wristband ?? code)?.trim();
    if (cleanCode) {
      const result = await this.checkinService.getParticipant(user.eventId!, {
        wristband: cleanCode,
      });
      if (!result)
        throw new NotFoundException(
          `${cleanCode} is not issued to anyone — the mapping table has it as neither a wristband nor a transponder`,
        );
      return result;
    }

    throw new BadRequestException(
      'Either bib or wristband/code query parameter is required',
    );
  }

  @Get('context')
  @SetMetadata(HJUDGE_ROLES_KEY, COUNTER_ROLES)
  getContext(@HjudgeUserParam() user: HjudgeUser) {
    return this.checkinService.getContext(user);
  }

  @Post('stage')
  @SetMetadata(HJUDGE_ROLES_KEY, COUNTER_ROLES)
  async completeStage(
    @Body()
    body: {
      bib?: string;
      wristband?: string;
      stageType?: string;
      assetCode?: string;
      governmentIdVerified?: boolean;
      verbalDeclarationAccepted?: boolean;
    },
    @HjudgeUserParam() user: HjudgeUser,
  ) {
    // Either identifier. An athlete arriving for a wristband has the BIB they
    // gave; one arriving for a transponder has the band they are wearing, and
    // the service resolves it through the mapping table — freshly, so a band
    // reassigned since the lookup cannot put this transponder on the previous
    // wearer.
    const bib = String(body.bib ?? '').trim();
    const wristband = String(body.wristband ?? '').trim();

    if (!bib && !wristband)
      throw new BadRequestException('A BIB or a wristband is required');
    if (bib && !/^\d+$/.test(bib))
      throw new BadRequestException('A numeric BIB is required');
    if (!body.assetCode?.trim())
      throw new BadRequestException('An asset code is required');

    // `stageType` is optional and, when sent, is only what the screen believed
    // it was doing. The service decides the stage from what the athlete already
    // holds and rejects a request that disagrees, so a stale tab cannot write a
    // transponder into the wristband column.
    if (body.stageType !== undefined && !isCheckinStage(body.stageType))
      throw new BadRequestException('Unrecognised check-in stage');

    return this.checkinService.completeStage(
      {
        bib: bib || undefined,
        wristband: wristband || undefined,
        stageType: isCheckinStage(body.stageType) ? body.stageType : undefined,
        assetCode: body.assetCode,
        governmentIdVerified: body.governmentIdVerified,
        verbalDeclarationAccepted: body.verbalDeclarationAccepted,
      },
      user,
    );
  }
}
