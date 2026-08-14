import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { HjudgeUser } from '../hjudge-auth.guard';
import {
  HjudgeRaceResultService,
  type RaceResultConfig,
} from './hjudge-raceresult.service';
import {
  assignmentFor,
  bibKey,
  findTeammates,
  holderOfAsset,
  nextStageFor,
  stagesFor,
  stageWriteTargets,
  teamWarning,
  isDoublesContest,
  isDoublesContestId,
  type AssignmentTable,
  type CheckinRoster,
  type CheckinRosterEntry,
  type CheckinStageType,
} from '../hjudge-checkin-rr.util';
import {
  checkinWindowPolicy,
  evaluateCheckinWindow,
  defaultCheckinWindowPolicy,
} from '../hjudge-checkin-window.util';

/**
 * The check-in counter, backed by RaceResult.
 *
 * Nothing about a check-in is stored here, and that now includes which stage a
 * counter runs. There are no Stage 1 desks and Stage 2 desks: one counter runs
 * whichever stage the athlete in front of it is due, worked out from the
 * equipment they are already holding —
 *
 *     no wristband                → Stage 1, hand over a wristband
 *     wristband, no transponder   → Stage 2, hand over a transponder
 *     both                        → nothing left to do, and it says so
 *
 * That answer comes from the event's **mapping table**, which is the authority
 * on equipment: what a BIB holds, and who a scanned code belongs to. The
 * participant feed supplies identity — name, contest, slot, club — and decides
 * nothing. It is read once more after a write, to confirm RaceResult really
 * stored what it said it stored, and that is the only thing its stage flags are
 * ever consulted for.
 *
 * The database is consulted for exactly two things, neither of which is
 * check-in state: who the volunteer is (the session, in the guard) and where
 * this event's RaceResult endpoints are (via HjudgeRaceResultService).
 *
 * This is why there is no outbox, no stage record and no asset assignment. A
 * failed write means the check-in did not happen, and the volunteer — who is
 * standing in front of the athlete — presses the button again. `savevalue` sets
 * a value rather than appending one, so repeating the whole operation is
 * harmless, which is what makes "try again" an honest answer instead of a way
 * to write something twice.
 */

/**
 * What "checked in" is written as.
 *
 * `stage1checkin` / `stage2checkin` are BOOLEAN fields in RaceResult — the
 * participant feed returns them as JSON `false`, not as an empty string — so
 * this has to be something the server stores as true. **`1` is stored as true;
 * confirmed with the organiser on 2026-08-12.** The string `COMPLETED` was
 * written here while the field was assumed to be text.
 *
 * The reader (`readRecordFlag`) treats `1`, `true` and any other non-negative
 * value alike, so a change here cannot orphan check-ins already written.
 */
const CHECKIN_FLAG_SET = '1';

/** How a stage is named to a volunteer. */
function stageLabel(stage: CheckinStageType) {
  return stage === 'STAGE_1_WRISTBAND' ? 'Stage 1' : 'Stage 2';
}

/** RaceResult's own clock format, in the event's zone. */
function raceResultLocalTimestamp(value: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}:${part('second')}`;
}

@Injectable()
export class HjudgeCheckinService {
  private readonly logger = new Logger(HjudgeCheckinService.name);

  constructor(private readonly rr: HjudgeRaceResultService) {}

  // ------------------------------------------------------------- responses

  private windowFor(entry: CheckinRosterEntry, config: RaceResultConfig) {
    return evaluateCheckinWindow(
      config.checkinWindowEnabled
        ? checkinWindowPolicy(config)
        : defaultCheckinWindowPolicy,
      {
        timeslot: entry.person.timeslot,
        contestDate: entry.person.contestDate,
        eventDate: config.eventDate,
        eventStartsAt: config.eventStartsAt,
        timeZone: config.timeZone,
      },
      new Date(),
    );
  }

  private async present(
    entry: CheckinRosterEntry,
    config: RaceResultConfig,
    eventId: string,
    assignments: AssignmentTable,
    roster?: CheckinRoster,
  ) {
    const doubles =
      isDoublesContestId(entry.person.contestId) ||
      isDoublesContest(entry.person.category);

    // The full list is only pulled when the athlete is actually in a doubles
    // contest — for everyone else a partner lookup would be 950 KB spent to
    // discover there is no partner.
    const full =
      doubles && entry.person.club.trim()
        ? (roster ?? (await this.rr.fetchFullRoster(config, eventId)))
        : null;
    const teammates = full ? findTeammates(full, entry) : [];

    const assignment = assignmentFor(assignments, entry.person.bib);

    return {
      participant: entry.person,
      window: this.windowFor(entry, config),
      /**
       * What this athlete holds, and therefore what is left to give them —
       * from the mapping table, which is the only thing this response says
       * about equipment.
       *
       * `stages` alongside it is the same row read backwards: which hand-overs
       * have already happened. Both come off `assignment`, so the three fields
       * are one answer in three shapes and cannot contradict each other.
       *
       * That is the whole difference from the old `stages`, which was removed
       * for good reason: it carried the `stage1checkin` / `stage2checkin` flags
       * off the participant feed — a second source, able to disagree with the
       * equipment, with nothing in the payload to say which one counted. This
       * one is not a second opinion. It is here because the counters ask "has
       * Stage 1 happened?" and a response that only answers "what is left?"
       * leaves them telling a volunteer that an athlete already wearing a band
       * has not been through Stage 1.
       */
      assignment,
      nextStage: nextStageFor(assignment),
      stages: stagesFor(assignment, entry.stages),
      // Teammate progress reads the mapping table too, so a partner's row and
      // the athlete's own cannot disagree about what counts as done.
      teammates: teammates.map((mate) => {
        const theirs = assignmentFor(assignments, mate.person.bib);
        return {
          ...mate.person,
          nextStage: nextStageFor(theirs),
          wristbandIssued: Boolean(theirs.wristband.trim()),
          transponderIssued: Boolean(theirs.transponder.trim()),
          // Same reading for a partner as for the athlete, for the counters
          // that ask a teammate's progress this way round. A doubles pair whose
          // two rows answered in different shapes is how one of them ends up
          // showing "Waiting" with the band already on their wrist.
          stages: stagesFor(theirs, mate.stages),
        };
      }),
      teamWarning: doubles ? teamWarning(entry, teammates) : null,
    };
  }

  // ----------------------------------------------------------------- reads

  async getParticipant(
    eventId: string,
    params: { bib?: string; wristband?: string },
  ) {
    const config = await this.rr.loadConfig(eventId);
    this.rr.requireFeed(config);

    // The athlete gives a race number, and it goes straight to the participant
    // feed as `?bib=` — a real server-side filter, a few hundred bytes rather
    // than the whole start list.
    //
    // Or they are carrying nothing but equipment they were issued earlier, and
    // it takes two hops: the mapping table turns the code into a BIB — matching
    // it against both the wristband and the transponder column, because which
    // one they hand over is theirs to choose — and the participant feed turns
    // that BIB into the athlete.
    const entry = params.bib
      ? await this.rr.fetchAthlete(config, eventId, params.bib)
      : params.wristband
        ? await this.rr.fetchAthleteByAssetCode(
            config,
            eventId,
            params.wristband,
          )
        : null;
    if (!entry) return null;

    const assignments = await this.rr.fetchAssignments(config, eventId);
    return this.present(entry, config, eventId, assignments);
  }

  /**
   * Who this volunteer is, and everything that decides whether their counter
   * can work at all.
   *
   * `stage` is the shift the Team screen rostered them onto, and it is here to
   * be shown, not obeyed: the counter still runs whichever hand-over the
   * athlete in front of it is due — `nextStage` on the participant lookup —
   * because the equipment they already hold is the only thing that can say what
   * is left to give them. A volunteer with no stage, or one rostered to Stage 1
   * standing at a transponder desk, works exactly as before.
   *
   * It is reported because a tablet that cannot say whose shift it is signed in
   * to is a tablet nobody can hand over at the end of one.
   */
  async getContext(user: HjudgeUser) {
    const config = await this.rr.loadConfig(user.eventId!);

    // Whether the mapping table carries both asset columns decides whether this
    // counter can run either stage, so it is established once here rather than
    // discovered by a volunteer halfway through a queue. A column the table
    // does not have is indistinguishable from an empty one row by row, and
    // reading it as "nobody has one" would hand the same transponder to the
    // whole field.
    let publishesWristband = false;
    let publishesTransponder = false;
    let mappingReadable = false;
    if (this.rr.canUseMapLookup(config)) {
      try {
        const table = await this.rr.fetchAssignments(config, user.eventId!);
        mappingReadable = true;
        // An empty table publishes no columns, and that is not a misconfigured
        // event — it is the morning of one, before anybody has been issued
        // anything. Only a table with rows in it can be judged.
        publishesWristband = !table.rowCount || table.publishesWristband;
        publishesTransponder = !table.rowCount || table.publishesTransponder;
      } catch {
        /* An endpoint we cannot read is reported by the first lookup. */
      }
    }

    return {
      volunteer: { id: user.id, staffId: user.staffId, name: user.name },
      // Top level rather than on `volunteer`, because that is the key the
      // counter clients already read — one place for it, so there is no second
      // copy to disagree with this one.
      stage: user.checkinStage ?? null,
      integration: {
        configured: this.rr.isConfigured(config),
        canWrite: this.rr.canWrite(config),
        mappingConfigured: this.rr.canUseMapLookup(config),
        mappingReadable,
        publishesWristband,
        publishesTransponder,
      },
      policy: {
        declarationText: config.declarationText,
        declarationVersion: config.declarationVersion,
        checkinWindowEnabled: config.checkinWindowEnabled,
        checkinOpensBeforeMinutes: config.checkinOpensBeforeMinutes,
        checkinClosesAfterMinutes: config.checkinClosesAfterMinutes,
      },
    };
  }

  // ----------------------------------------------------------------- write

  /**
   * Hand equipment over and record it.
   *
   * The athlete is named by whichever identifier the counter actually has. At
   * Stage 1 that is the BIB the athlete gave. At Stage 2 it is the WRISTBAND
   * they are wearing, and the mapping table is re-read here — fresh — to turn
   * it into a BIB.
   *
   * Resolving the band again rather than trusting the one the lookup returned
   * is the point. The lookup may have been served from a 20-second cache, and
   * a band reassigned inside that window would otherwise write this
   * transponder onto the athlete who used to be wearing it.
   */
  async completeStage(
    data: {
      bib?: string;
      wristband?: string;
      /** What the screen believed it was running. An assertion, not an
       *  instruction — the server works the stage out for itself and refuses if
       *  the two disagree. */
      stageType?: CheckinStageType;
      assetCode: string;
      governmentIdVerified?: boolean;
      verbalDeclarationAccepted?: boolean;
    },
    user: HjudgeUser,
  ) {
    const assetCode = data.assetCode.trim();
    if (!assetCode) throw new BadRequestException('An asset code is required');

    const config = await this.rr.loadConfig(user.eventId!);
    this.rr.requireFeed(config);
    this.rr.requireMapLookup(config);

    // Fresh at every hop, not cached: the checks below are the only thing
    // standing between an athlete and a second wristband — or between two
    // athletes and the same one — and a 20-second-old copy would let two
    // counters both decide a band was free.
    const band = String(data.wristband ?? '').trim();
    const bib = String(data.bib ?? '').trim();
    if (!band && !bib)
      throw new BadRequestException('A BIB or a wristband is required');

    const entry = band
      ? await this.rr.fetchAthleteByAssetCode(config, user.eventId!, band, {
          fresh: true,
        })
      : await this.rr.fetchAthlete(config, user.eventId!, bib, { fresh: true });

    if (!entry)
      throw new BadRequestException(
        band
          ? `${band} is not against any BIB in the mapping table — it is issued as neither a wristband nor a transponder`
          : `BIB ${bib} was not found`,
      );

    const assignments = await this.rr.fetchAssignments(config, user.eventId!, {
      fresh: true,
    });
    const assignment = assignmentFor(assignments, entry.person.bib);
    const stage = nextStageFor(assignment);

    // Both already issued. Replacing equipment is a Help Desk job, not a
    // counter one — the counter's answer is that this athlete is done.
    if (!stage) {
      throw new BadRequestException(
        `BIB ${entry.person.bib} already holds wristband ${assignment.wristband} and transponder ${assignment.transponder}. Send them to the Help Desk to replace either one.`,
      );
    }

    // The screen and the table disagree, which means the athlete's row moved
    // between the lookup and the button — another desk got there first, most
    // likely. Writing the stage the screen was showing would put a transponder
    // in the wristband column.
    if (data.stageType && data.stageType !== stage) {
      throw new BadRequestException(
        `BIB ${entry.person.bib} is now due ${stageLabel(stage)}, not ${stageLabel(data.stageType)}. Scan them again.`,
      );
    }

    // The mapping table has to actually carry the column being read, or "nobody
    // holds this" is not an answer it gave — it is one nobody asked for.
    if (
      assignments.rowCount &&
      (stage === 'STAGE_1_WRISTBAND'
        ? !assignments.publishesWristband
        : !assignments.publishesTransponder)
    ) {
      throw new BadRequestException(
        `The equipment mapping table has no ${stage === 'STAGE_1_WRISTBAND' ? 'wristband' : 'transponder'} column, so this counter cannot tell whether a code is already issued. Fix the mapping endpoint in Operations before handing anything over.`,
      );
    }

    if (
      stage === 'STAGE_1_WRISTBAND' &&
      (data.governmentIdVerified !== true ||
        data.verbalDeclarationAccepted !== true)
    ) {
      throw new BadRequestException(
        'Government ID and participant declaration must be confirmed',
      );
    }

    // Is this code already on somebody? The whole reason the mapping table is
    // read fresh. A code on two athletes corrupts the timing data for both, and
    // it is silent — nothing downstream reports it, because both rows look
    // perfectly valid on their own.
    const holder = holderOfAsset(assignments, assetCode, stage);
    if (holder && bibKey(holder.bib) !== bibKey(entry.person.bib)) {
      const name = await this.nameOf(config, user.eventId!, holder.bib);
      throw new BadRequestException(
        `${stage === 'STAGE_1_WRISTBAND' ? 'Wristband' : 'Transponder'} ${assetCode} is already assigned to BIB ${holder.bib}${name ? ` (${name})` : ''}. Scan a different one.`,
      );
    }

    // The window is a counter rule, so it is enforced at the counter and not
    // above it: an event_admin or super_admin standing at a desk is the
    // override the Help Desk needs when a slot is wrong.
    if (user.role === 'checkin') {
      const window = this.windowFor(entry, config);
      if (!window.allowed) throw new BadRequestException(window.message);
    }

    const completedAt = new Date();
    const { status, time, asset, assignedBy } = stageWriteTargets(
      config.updateMapping,
      stage,
    );
    const stamp = raceResultLocalTimestamp(completedAt, config.timeZone);

    // Asset, then who issued it, then the time, then the status. Four separate
    // GETs cannot be one transaction, so the order decides what a half-finished
    // check-in looks like: the status field is the one that means "this athlete
    // has been through", and it is written only once everything it vouches for
    // is already recorded. Each write sets a value rather than adding one, so
    // re-running the whole stage after a failure repairs it.
    //
    // Each of the four may be more than one column on an event that mirrors a
    // value — the mirrors go first within a step, and the step is only finished
    // once they all have, so the ordering above holds however many there are.
    await this.writeAll(config, entry.person.bib, asset, assetCode);
    await this.writeAll(config, entry.person.bib, assignedBy, user.staffId);
    await this.writeAll(config, entry.person.bib, time, stamp);
    await this.writeAll(config, entry.person.bib, status, CHECKIN_FLAG_SET);

    // Read it back before telling the volunteer it is done.
    //
    // `savevalue` answers 200 with a body of `0` for everything — including a
    // fieldname that does not exist on the event, which was verified against
    // _386828 on 2026-08-12. So the HTTP status proves only that the server was
    // reached, and one wrong name in the update mapping would discard every
    // check-in of the event while the counter reported success. The only
    // trustworthy confirmation is the athlete's own row saying so, and reading
    // one bib is a few hundred bytes.
    const confirmed = await this.rr.fetchAthlete(
      config,
      user.eventId!,
      entry.person.bib,
      { fresh: true },
    );
    if (!confirmed?.stages[stage]) {
      throw new BadRequestException(
        `RaceResult accepted the write but BIB ${entry.person.bib} still does not read as ${stageLabel(stage)} complete. Check the update field mapping in Operations — a field name RaceResult does not have is accepted silently.`,
      );
    }

    this.logger.log(
      `${stage} complete for BIB ${entry.person.bib} by ${user.staffId} (${assetCode})`,
    );

    // The stage the athlete is due NEXT, so the receipt can say whether they are
    // finished or should join the other queue. Derived from what was just
    // written rather than re-read: the mapping table is a cache away from
    // agreeing, and this is the one place we know exactly what changed.
    const remaining = nextStageFor({
      bib: entry.person.bib,
      wristband:
        stage === 'STAGE_1_WRISTBAND' ? assetCode : assignment.wristband,
      transponder:
        stage === 'STAGE_2_TRANSPONDER' ? assetCode : assignment.transponder,
    });

    return {
      bib: entry.person.bib,
      stageType: stage,
      assetCode,
      completedAt: stamp,
      nextStage: remaining,
      state: 'completed' as const,
    };
  }

  /** The name against a BIB, for an error message that has to name somebody.
   *  Best effort — a conflict is still a conflict if the feed will not say. */
  private async nameOf(
    config: RaceResultConfig,
    eventId: string,
    bib: string,
  ): Promise<string> {
    try {
      const found = await this.rr.fetchAthlete(config, eventId, bib);
      return found?.person.name ?? '';
    } catch {
      return '';
    }
  }

  /** One value into every column the mapping points a step at, in order. */
  private async writeAll(
    config: RaceResultConfig,
    bib: string,
    fieldNames: string[],
    value: string,
  ) {
    for (const fieldName of fieldNames) {
      await this.rr.writeField(config, bib, fieldName, value);
    }
  }
}
