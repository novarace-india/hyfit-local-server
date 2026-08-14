import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import {
  HjudgeIngestGuard,
  type HjudgeIngestPrincipal,
} from '../hjudge-ingest.guard';
import {
  HjudgeIngestService,
  type IngestAthleteRow,
  type IngestChunk,
  type IngestResultRow,
} from '../services/hjudge-ingest.service';

/**
 * The push endpoint an offline event's local server writes to. Three routes,
 * and there will not be a fourth.
 *
 * THE SCOPE IS THE POINT. A venue laptop needs to publish a start list and
 * standings; it does not need to create staff, read PINs, open sessions, or see
 * the RaceResult URLs — which are themselves credentials. So this controller
 * carries the two writes and one read that job requires, guarded by a
 * credential that can reach exactly one event, and nothing else in this module
 * is reachable with it. Adding a route here widens what a token found in a chat
 * message is worth; think of it that way before adding one.
 *
 * IT IS NOT UNDER /admin. The admin controller is defended by
 * `HjudgeAuthGuard` + `HjudgeRolesGuard`, which want a staff session — a thing
 * a headless server at a venue does not have and should not be given, because
 * an account it could sign in as would be an account that also opens check-in.
 *
 * SHAPE OF A PUSH. The sender splits a snapshot into chunks small enough for
 * the receiving body parser, tags every chunk with one `batch` uuid, and marks
 * the last one `final: true`. Each chunk is written and committed on arrival;
 * the final call additionally prunes whatever the batch did not bring. A chunk
 * that fails can simply be sent again — every write is an upsert keyed by the
 * row's own id, so a replay lands the same rows in the same state.
 *
 * Like every other route in this module, these sit under `/api/hyfit-judge/`,
 * which the host app's global guards, response envelope and exception filter
 * all carve out — so the status codes and error bodies here are Nest's own on
 * both deployments, and the sender can read them the same way in each.
 */
@Controller('hyfit-judge/ingest')
@UseGuards(HjudgeIngestGuard)
export class HjudgeIngestController {
  constructor(private readonly ingest: HjudgeIngestService) {}

  private principal(request: unknown): HjudgeIngestPrincipal {
    return (request as { hjudgeIngest: HjudgeIngestPrincipal }).hjudgeIngest;
  }

  /**
   * "What does this credential open?"
   *
   * Called once when an operator binds a local server, and again before every
   * scheduled push as a cheap liveness check — it is the call that turns "the
   * credential expired overnight" from a silent stall into a line on the Sync
   * screen.
   *
   * The event id is in the path so a mis-pasted credential fails here, on a
   * read, rather than on the first write.
   */
  @Get('events/:eventId/handshake')
  handshake(@Req() request: unknown, @Param('eventId') _eventId: string) {
    return this.ingest.handshake(this.principal(request));
  }

  /** One chunk of the roster. See HjudgeIngestService.ingestAthletes. */
  @Post('events/:eventId/athletes')
  athletes(
    @Req() request: unknown,
    @Param('eventId') _eventId: string,
    @Body() body: IngestChunk<IngestAthleteRow>,
  ) {
    return this.ingest.ingestAthletes(this.principal(request), body);
  }

  /** One chunk of the standings. See HjudgeIngestService.ingestResults. */
  @Post('events/:eventId/results')
  results(
    @Req() request: unknown,
    @Param('eventId') _eventId: string,
    @Body() body: IngestChunk<IngestResultRow>,
  ) {
    return this.ingest.ingestResults(this.principal(request), body);
  }
}
