import { Controller, Get, NotFoundException, Param } from '@nestjs/common';
import { HjudgeResultsService } from '../services/hjudge-results.service';
import { HjudgeDbService } from '../hjudge-db.service';

/**
 * The only unauthenticated routes in this module.
 *
 * Everything else here is a counter, a tablet or a console, and is behind a
 * session. Results are the one thing an event exists to publish, and requiring
 * a login to read them would mean the standings on the venue screen and the
 * standings an athlete's family sees are two different products.
 *
 * WHAT MUST NOT LEAK. `hyfit_v2.athletes` holds mobile numbers and dates of
 * birth, and `raceresults_endpoints` holds URLs that are themselves access
 * credentials. Neither is reachable from here: the results read goes through
 * `HjudgeResultsService.publicResults`, which builds its rows from the results
 * columns alone and strips the source URL on the way out. When adding a route
 * to this controller, assume every field it returns is public, because it is.
 *
 * An event that has not switched results on answers 404 rather than an empty
 * list — "no standings published" and "nobody has finished" are different
 * facts, and a page that cannot tell them apart shows an empty leaderboard for
 * a race that has not started.
 */
@Controller('hyfit-judge/public')
export class HjudgePublicController {
  constructor(
    private readonly results: HjudgeResultsService,
    private readonly db: HjudgeDbService,
  ) {}

  /** The event, as much of it as a stranger may see. Enough for a results page
   *  to title itself without a second authenticated call. */
  @Get('events/:eventId')
  async event(@Param('eventId') eventId: string) {
    const { rows } = await this.db.q(
      `SELECT id, name, venue, event_date, timezone, results_mode
         FROM events WHERE id = $1`,
      [eventId],
    );
    if (!rows[0]) throw new NotFoundException('Event not found');
    return { event: rows[0] };
  }

  @Get('events/:eventId/results')
  async eventResults(@Param('eventId') eventId: string) {
    const payload = await this.results.publicResults(eventId);
    if (!payload)
      throw new NotFoundException(
        'No results are published for this event yet',
      );
    return payload;
  }
}
