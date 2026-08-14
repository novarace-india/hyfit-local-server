import { Module } from '@nestjs/common';
import { CacheModule } from '../common/cache/cache.module';
import { HyfitJudgeModule } from '../hyfit-judge/hyfit-judge.module';

import { HfgDbService } from './hfg-db.service';
import { HfgCacheService } from './hfg-cache.service';
import { HfgOtpService } from './services/hfg-otp.service';
import { HfgResultsService } from './services/hfg-results.service';
import { HfgLiveResultsService } from './services/hfg-live-results.service';
import { HfgRosterService } from './services/hfg-roster.service';
import { HfgSetupService } from './services/hfg-setup.service';
import { HfgCertificateService } from './services/hfg-certificate.service';

import { HfgHealthController } from './controllers/hfg-health.controller';
import { HfgAuthController } from './controllers/hfg-auth.controller';
import { HfgAthleteController } from './controllers/hfg-athlete.controller';
import { HfgEventsController } from './controllers/hfg-events.controller';
import { HfgTimingController } from './controllers/hfg-timing.controller';
import { HfgAdminController } from './controllers/hfg-admin.controller';
import { HfgSetupController } from './controllers/hfg-setup.controller';

// The HYFIT Games athlete platform, ported from a standalone Express + Postgres
// app into the Novarace NestJS backend. All routes live under
// /api/hyfitgames/*, the data lives in the dedicated `hyfitgames` Postgres
// schema (via HfgDbService's search-path pool), and cached reads live under the
// `hyfitgames:` Valkey namespace (via HfgCacheService over the shared
// CacheService). The module runs its own mobile+OTP / admin auth, independent of
// the host app's session system.
// HyfitJudgeModule is imported for one thing only: the admin console at
// /hyfitgames/admin now hosts the field-operations screens (Team, Operations,
// Event Control) as well as the athlete ones, so a single console sign-in has
// to open the judge session those screens call with. The import is one-way —
// the judge module knows nothing about this one.
@Module({
  imports: [CacheModule, HyfitJudgeModule],
  controllers: [
    HfgHealthController,
    HfgAuthController,
    HfgAthleteController,
    HfgEventsController,
    HfgTimingController,
    HfgAdminController,
    HfgSetupController,
  ],
  providers: [
    HfgDbService,
    HfgCacheService,
    HfgOtpService,
    HfgResultsService,
    HfgLiveResultsService,
    HfgRosterService,
    HfgSetupService,
    HfgCertificateService,
  ],
})
export class HyfitgamesModule {}
