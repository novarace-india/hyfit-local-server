import { Module } from '@nestjs/common';
import { CacheModule } from '../common/cache/cache.module';

import { HjudgeDbService } from './hjudge-db.service';
import { HjudgeCacheService } from './hjudge-cache.service';
import { HjudgeRaceSubmitService } from './services/hjudge-race-submit.service';
import { HjudgeAuthService } from './services/hjudge-auth.service';
import { HjudgeAdminService } from './services/hjudge-admin.service';
import { HjudgeCheckinService } from './services/hjudge-checkin.service';
import { HjudgeRaceResultService } from './services/hjudge-raceresult.service';
import { HjudgeJudgeService } from './services/hjudge-judge.service';
import { HjudgeParticipantSyncService } from './services/hjudge-participant-sync.service';

import { HjudgeAuthController } from './controllers/hjudge-auth.controller';
import { HjudgeAdminController } from './controllers/hjudge-admin.controller';
import { HjudgeCheckinController } from './controllers/hjudge-checkin.controller';
import { HjudgeCheckinAuthController } from './controllers/hjudge-checkin-auth.controller';
import { HjudgeJudgeController } from './controllers/hjudge-judge.controller';
import { HjudgeParticipantsController } from './controllers/hjudge-participants.controller';

import { HjudgeAuthGuard, HjudgeCheckinAuthGuard } from './hjudge-auth.guard';
import { HjudgeRolesGuard } from './hjudge-roles.guard';

// The Hyfit Judge module: race operations, check-in, timing, and RaceResult
// integration. Ported from the standalone hyfitgamesjudgeapp-main into the
// Novarace NestJS backend. All routes live under /api/hyfit-judge/*, data lives
// in the dedicated `hyfit_judge` Postgres schema (via HjudgeDbService's
// search-path pool), and cached reads live under the `hjudge:` Valkey namespace.
// The module runs its own PIN-based session auth, independent of the host app's
// JWT system.
@Module({
  imports: [CacheModule],
  controllers: [
    HjudgeAuthController,
    HjudgeAdminController,
    HjudgeCheckinController,
    HjudgeCheckinAuthController,
    HjudgeJudgeController,
    HjudgeParticipantsController,
  ],
  providers: [
    HjudgeDbService,
    HjudgeCacheService,
    HjudgeAuthGuard,
    HjudgeCheckinAuthGuard,
    HjudgeRolesGuard,
    HjudgeRaceSubmitService,
    HjudgeAuthService,
    HjudgeAdminService,
    HjudgeRaceResultService,
    HjudgeCheckinService,
    HjudgeJudgeService,
    HjudgeParticipantSyncService,
  ],
  // HjudgeAuthService is exported for HyfitgamesModule alone: the merged admin
  // console signs in once with email + password and needs a field session
  // opened on the same `hyfit_v2.users` row. See openLinkedSession.
  exports: [HjudgeDbService, HjudgeAuthService],
})
export class HyfitJudgeModule {}
