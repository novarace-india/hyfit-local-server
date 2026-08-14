import {
  Module,
  NestModule,
  MiddlewareConsumer,
  RequestMethod,
} from '@nestjs/common';
import { RequestIdMiddleware } from './common/middleware/request-id.middleware';
import { CorsMiddleware } from './common/middleware/cors.middleware';
import { HyfitgamesModule } from './hyfitgames/hyfitgames.module';
import { HyfitJudgeModule } from './hyfit-judge/hyfit-judge.module';

// Standalone HYFIT backend: the two HYFIT modules lifted out of the Novarace
// NestJS app, with nothing else mounted.
//
// What the host app contributed and this one does not need:
//   - TypeOrmModule.forRoot(): the HYFIT modules never touch TypeORM. Both run
//     their own `pg` pool pinned to the `hyfit` schema (HfgDbService /
//     HjudgeDbService), configured from the same DB_* env vars, so dropping the
//     ORM connection changes nothing for them.
//   - The global JwtAuthGuard / RolesGuard: every /api/hyfitgames/* controller
//     is @Public() and both guards explicitly skip /api/hyfit-judge/*, so the
//     HYFIT routes were never gated by them. Authorisation lives entirely in
//     the modules' own guards (HfgAdminGuard, HfgAthleteGuard, HfgTimingGuard,
//     HjudgeAuthGuard, HjudgeRolesGuard).
//   - Rate limiting: only ever applied to host routes (auth, results) that do
//     not exist here.
@Module({
  imports: [HyfitgamesModule, HyfitJudgeModule],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // Security headers come from Helmet in server.ts.
    consumer
      .apply(RequestIdMiddleware, CorsMiddleware)
      .forRoutes({ path: '*path', method: RequestMethod.ALL });
  }
}
