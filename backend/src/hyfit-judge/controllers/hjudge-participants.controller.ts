import { Controller, Get, UseGuards, SetMetadata } from '@nestjs/common';
import { HjudgeParticipantSyncService } from '../services/hjudge-participant-sync.service';
import { HjudgeUserParam } from '../hjudge-user.decorator';
import type { HjudgeUser } from '../hjudge-auth.guard';
import { HjudgeAuthGuard } from '../hjudge-auth.guard';
import { HjudgeRolesGuard, HJUDGE_ROLES_KEY } from '../hjudge-roles.guard';

@Controller('hyfit-judge/participants')
@UseGuards(HjudgeAuthGuard, HjudgeRolesGuard)
export class HjudgeParticipantsController {
  constructor(private readonly syncService: HjudgeParticipantSyncService) {}

  @Get()
  @SetMetadata(HJUDGE_ROLES_KEY, [
    'super_admin',
    'event_admin',
    'judge',
    'checkin',
    'readonly',
  ])
  listParticipants(@HjudgeUserParam() user: HjudgeUser) {
    // The STAFF ID, not the row id: `judgedby` holds what a judge is
    // known by, and comparing it against a uuid would make every athlete
    // somebody else's.
    return this.syncService.listParticipants(user.eventId!, user.staffId);
  }
}
