import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
} from '@nestjs/common';
import { HjudgeResultsService } from '../services/hjudge-results.service';
import { HjudgeCertificatesService } from '../services/hjudge-certificates.service';
import { HjudgeCheckinService } from '../services/hjudge-checkin.service';
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
    private readonly certificates: HjudgeCertificatesService,
    private readonly checkin: HjudgeCheckinService,
    private readonly db: HjudgeDbService,
  ) {}

  /**
   * Every edition a stranger may see, newest first.
   *
   * This is the public app's front door: with athlete login switched off (see
   * `lib/flags.ts` in the frontend) the whole product is this list and the
   * board behind each row, so a list that needed a session would leave nothing
   * to open at all.
   *
   * `draft` is excluded because it means an event nobody has finished setting
   * up — a name and a date the organiser is still deciding. Everything past
   * that is listed even when no standings exist yet, with `results_published`
   * saying which is which: an athlete who raced this morning looking for a
   * board that is not up yet is better served by "not published yet" on the
   * event they recognise than by an empty list that cannot tell them whether
   * the event exists.
   *
   * Only the columns the single-event route already publishes, for the reason
   * in this controller's header — assume every field here is public, because
   * it is.
   */
  @Get('events')
  async events() {
    const { rows } = await this.db.q(
      // `event_date` is a calendar DAY, and it leaves here as one. Left as a
      // `date`, node-pg hands back a JS Date at local midnight and JSON writes
      // it as a UTC instant — "2026-08-15" reaches the browser as
      // "2026-08-14T18:30:00.000Z", and every reader in India is shown the day
      // before the event.
      // `event_end_date` rides along so the list can say "15 - 16 Aug" rather
      // than naming Day 1 and implying the edition was over that evening. NULL
      // means a single-day event, and the page renders one date for it.
      `SELECT id, name, venue,
              to_char(event_date, 'YYYY-MM-DD') AS event_date,
              to_char(event_end_date, 'YYYY-MM-DD') AS event_end_date,
              timezone, status,
              (results_mode <> 'off') AS results_published
         FROM events
        WHERE status <> 'draft'
        ORDER BY event_date DESC NULLS LAST, name`,
    );
    return { events: rows };
  }

  /** The event, as much of it as a stranger may see. Enough for a results page
   *  to title itself without a second authenticated call. */
  @Get('events/:eventId')
  async event(@Param('eventId') eventId: string) {
    const { rows } = await this.db.q(
      // Both days as calendar days, for the reason spelled out on the list
      // query above: a bare `date` column reaches the browser as a UTC instant
      // and reads as the day before.
      `SELECT id, name, venue,
              to_char(event_date, 'YYYY-MM-DD') AS event_date,
              to_char(event_end_date, 'YYYY-MM-DD') AS event_end_date,
              timezone, results_mode
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

  /**
   * The certificate design a finisher of `?contest=` prints on.
   *
   * A TEMPLATE, not a certificate. It carries artwork and a layout and no
   * athlete's data at all — the page already holds the standings row and draws
   * the document itself, which is why this route can be public without
   * publishing anybody's details a second time. It is also why it is cacheable
   * per contest rather than fetched per download.
   *
   * 404 when the event has no published design for that contest. The results
   * page reads that as "offer no Download button", which is the honest
   * outcome: an organiser who has not finished a certificate has not published
   * one.
   */
  /**
   * Which medal the athlete holding `?code=` is collecting.
   *
   * For the medal desk at the end of the floor, which is not a counter: it
   * reads a band and reads a column back, writes nothing, and is answerable
   * for nothing — so the tablet running it never signs in, and this is the
   * route that lets it not have to. Everything behind
   * `/hyfit-judge/checkin` wants a counter session, and a volunteer signing
   * into a counter they are not standing at just to read a colour out loud is
   * a worse answer than a public read.
   *
   * Public in the full sense this controller means it (see the header): the
   * service returns the athlete's name, contest, club, finish time, medal and
   * the two equipment codes, and nothing else. No date of birth and no mobile
   * number — those are on the same record and must not follow it out here.
   * The fields that do leave are the ones a published results board carries
   * already.
   *
   * A code rather than a BIB, deliberately. A race number is on the athlete's
   * chest and can be read from across a barrier; a band is something they are
   * holding, which makes the lookup one only the person at the desk with them
   * can make.
   */
  @Get('events/:eventId/medal')
  async medal(
    @Param('eventId') eventId: string,
    @Query('code') code?: string,
  ) {
    const clean = (code ?? '').trim();
    if (!clean)
      throw new BadRequestException(
        'A wristband or transponder code is required',
      );

    const athlete = await this.checkin.getMedal(eventId, clean);
    // Not an error, and worded so the desk can act on it: the usual cause is a
    // band that has not been handed over yet.
    if (!athlete)
      throw new NotFoundException(
        `${clean} is not issued to anyone — the mapping table has it as neither a wristband nor a transponder`,
      );

    return { athlete };
  }

  @Get('events/:eventId/certificate-template')
  async certificateTemplate(
    @Param('eventId') eventId: string,
    @Query('contest') contest?: string,
  ) {
    const template = await this.certificates.publicTemplate(eventId, contest);
    if (!template)
      throw new NotFoundException(
        'No certificate is published for this event yet',
      );
    return { template };
  }
}
