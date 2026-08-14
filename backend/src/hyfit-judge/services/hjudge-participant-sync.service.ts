import { Injectable } from '@nestjs/common';
import { HjudgeDbService } from '../hjudge-db.service';
import { HjudgeRaceResultService } from './hjudge-raceresult.service';
import { HjudgeUser } from '../hjudge-auth.guard';
// Raised with an HTTP status the controller maps straight through, so a
// misconfigured endpoint reads as 409 rather than a generic 500.
export class HjudgeSyncError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly runId?: string,
  ) {
    super(message);
  }
}

@Injectable()
export class HjudgeParticipantSyncService {
  constructor(
    private readonly db: HjudgeDbService,
    private readonly raceResult: HjudgeRaceResultService,
  ) {}

  /**
   * The roster a judge tablet downloads.
   *
   * The labels come back off `judgedby` on each athlete's own RaceResult
   * record: blank is 'Ready', this judge's own staff ID is 'Yours', anyone
   * else's is 'On course'. They used to be read off `race_sessions`, which no
   * longer exists — the hold moved to RaceResult rather than disappearing.
   *
   * 'Yours' and 'On course' need opposite handling in the app, which is why the
   * caller's staff ID is passed in: somebody else's athlete must stay
   * untouchable, while your own is a race to walk back into after a reload.
   */
  async listParticipants(eventId: string, judgeStaffId: string) {
    // Straight off the feed, identity and equipment together, rather than
    // joining the platform's roster to a second RaceResult read for the codes.
    // The start list a judge searches and the equipment they scan are the same
    // fact from the same place, and the athlete platform's roster is a separate
    // import that a field-only event does not have at all.
    const config = await this.raceResult.loadConfig(eventId);
    this.raceResult.requireFeed(config);
    const roster = await this.raceResult.fetchFullRoster(config, eventId);

    const now = new Date();
    return {
      participants: roster.entries.map(({ person, stages }) => ({
        // The bib is the identifier: with nothing stored, it is the only one
        // that means anything on both sides of a lookup.
        id: person.bib,
        bib: person.bib,
        name: person.name,
        category: person.category,
        contestId: person.contestId,
        wave: person.wave,
        club: person.club,
        // Same field, same reason as `shape()` in hjudge-judge.service.ts: an
        // athlete picked off the cached roster has to carry the date an
        // athlete resolved by wristband does, or the app sees it appear and
        // disappear depending on how the judge found them.
        dateOfBirth: person.dateOfBirth,
        // The app's own names for these; RaceResult's spellings are internal to
        // the lookup and must not leak into the roster the tablets cache.
        wristbandId: person.wristbandCode,
        transponder1: person.transponderCode,
        // The completed stage, NOT "a transponder code is present": the
        // organiser pre-populates Transponder1 for the whole field before the
        // event opens, so reading the code as evidence of a hand-over would
        // mark every athlete ready.
        stage2Ready: Boolean(stages.STAGE_2_TRANSPONDER),
        avatar: person.avatar,
        judgedBy: person.judgedBy,
        completed: person.completed,
        // Completed wins over a hold: an athlete who has finished is not
        // somebody's to resume, even their own judge's.
        status: person.completed
            ? 'Completed'
            : !person.judgedBy.trim()
              ? 'Ready'
              : person.judgedBy.trim().toLowerCase() ===
                  judgeStaffId.trim().toLowerCase()
                ? 'Yours'
                : 'On course',
      })),
      sync: {
        source: 'raceresult',
        fetchedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 60000).toISOString(),
        rejectedCount: roster.rejectedCount,
        stale: false,
      },
    };
  }

  // The roster import moved to the admin console (POST
  // /api/hyfitgames/admin/events/:id/roster/raceresult), and this route is kept
  // only to say so.
  //
  // It used to pull the RaceResult participant endpoint and upsert onto
  // `participants`. That table no longer exists: migrations 052/057 replaced it
  // with the single roster the whole platform shares, and 063 leaves a read-only
  // view in its place. Reinstating the write here would give one event two
  // importers writing two rosters — the exact split the schema merge was done to
  // remove — and this one could only ever target whichever event happens to be
  // flagged active.
  //
  // The console's importer is not a lesser version of this: it reads the same
  // published `event_configs` endpoint and mapping, parses with the same
  // `parseParticipantImport`, records the same `sync_runs` row, and can be aimed
  // at any event.
  runParticipantSync(user: HjudgeUser): never {
    if (!user.eventId)
      throw new HjudgeSyncError(
        'No event is assigned to this administrator',
        400,
      );
    throw new HjudgeSyncError(
      'Roster import has moved: open the event in the admin console and use its Roster tab. ' +
        'It pulls the same RaceResult endpoint into the shared roster, so check-in and the ' +
        'athlete platform can no longer disagree about who is racing.',
      409,
    );
  }
}
