import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { HjudgeRaceResultService } from './hjudge-raceresult.service';
import { resolveUpdateFields } from '../hjudge-update-mapping.util';
import { generateCognitiveSequence } from '../hjudge-race-rules';
import {
  findTeammates,
  isDoublesContestId,
  teamWarning,
  type CheckinRosterEntry,
} from '../hjudge-checkin-rr.util';

/**
 * Finding the athlete a judge is standing in front of.
 *
 * That is the whole of this service now. A race used to live here — sessions,
 * claims, splits, station outcomes, a ledger of every tap — and none of it does
 * any more: the tablet runs the race and hands the finished thing to
 * `HjudgeRaceSubmitService`, which scores it and writes it to RaceResult. There
 * is nothing left to store, so there is nothing left to read back.
 *
 * Claims are back, and they live where everything else does. `judgedby` on the
 * athlete's own RaceResult record holds the staff ID of the judge running them:
 * written on claim, cleared on release. That is a hold without a lock — two
 * judges cannot both believe they have an athlete, because the second one reads
 * the first one's name off the feed before starting.
 *
 * It is not atomic, and cannot be: RaceResult has no compare-and-set. Two
 * tablets claiming in the same second will both succeed and the later write
 * wins. That is a narrower window than the one it closes, and the alternative
 * is a lock table — the thing this cutover exists to remove.
 */
@Injectable()
export class HjudgeJudgeService {
  constructor(private readonly raceResult: HjudgeRaceResultService) {}

  /**
   * Resolves either code a judge can read off an athlete: the Stage 1
   * wristband or the Stage 2 transponder. Both must work — the app cannot
   * always tell which one it is holding.
   */
  async resolveWristband(eventId: string, code: string, judgeIdentity = '') {
    const found = await this.raceResult.findByCode(eventId, code);
    if (!found) return null;
    const { entry, roster, equipment, matchedAssetType } = found;

    const doubles = isDoublesContestId(entry.person.contestId);
    const teammates = doubles ? findTeammates(roster, entry) : [];

    // A pair is two people. More than that is a roster problem the judge must
    // not resolve by guessing, and the old bib-parity fallback guessed.
    const teammate =
      teammates.length === 1 ? this.shape(teammates[0], judgeIdentity) : null;

    return {
      participant: {
        ...this.shape(entry, judgeIdentity),
        stage2Ready: equipment.stage2Ready,
      },
      teammate,
      teamWarning: doubles ? teamWarning(entry, teammates) : null,
      matchedAssetType,
      // Always the wristband when the athlete has one: a doubles submission is
      // paired on wristband codes, so a partner found by transponder must still
      // hand back something that pairing can use.
      scannedWristbandCode: entry.person.wristbandCode || code,
    };
  }

  /**
   * Claims an athlete for this judge.
   *
   * Reads the athlete fresh, refuses one another judge is already running, and
   * writes this judge's staff ID to `judgedby`. Re-claiming an athlete this
   * judge already holds is a RESUME, not an error — a tablet that reloaded
   * mid-race has to be able to walk back into it.
   */
  async claim(
    eventId: string,
    // Either identifier the tablet has: a scanned band or transponder, or the
    // BIB it is already holding from the roster. The app sends one for a
    // wristband claim and the other when the judge picked from the list, and
    // both mean the same athlete.
    target: { code?: string; bib?: string },
    judgeStaffId: string,
  ) {
    const config = await this.raceResult.loadConfig(eventId);
    if (!this.raceResult.canWrite(config)) {
      throw new BadRequestException(
        'This event has no RaceResult update endpoint. Set one in Operations before judging.',
      );
    }

    const code = String(target.code ?? '').trim();
    const bib = String(target.bib ?? '').trim();
    if (!code && !bib)
      throw new BadRequestException(
        'A Wristband ID, Transponder ID or BIB is required',
      );

    // Fresh: the whole point is to see a claim another judge made seconds ago,
    // and a cached roster is exactly long enough to miss one.
    const entry = code
      ? (await this.raceResult.findByCode(eventId, code, { fresh: true }))?.entry
      : await this.raceResult.fetchAthlete(config, eventId, bib, {
          fresh: true,
        });
    if (!entry) return null;

    // Done is done. `statusofathelet` is 1 once a race has been handed in, and
    // it is the only thing on the record that says so — without this check a
    // second judge picks up a finished athlete, runs them again, and the
    // re-submission overwrites the real result field by field.
    //
    // Checked before the hold, so it beats a resume: an athlete who finished is
    // nobody's to walk back into, not even their own judge's.
    if (entry.person.completed) {
      throw new ConflictException(
        `BIB ${entry.person.bib} has already completed their race and cannot be judged again. Ask Event Control if this is wrong.`,
      );
    }

    const holder = entry.person.judgedBy.trim();
    const mine = judgeStaffId.trim();

    if (holder && holder.toLowerCase() !== mine.toLowerCase()) {
      throw new ConflictException(
        `BIB ${entry.person.bib} is already being judged by ${holder}. Ask Event Control before taking them over.`,
      );
    }

    const resumed = holder.toLowerCase() === mine.toLowerCase();
    if (!resumed) {
      for (const fieldName of resolveUpdateFields(
        config.updateMapping,
        'judgedby',
      )) {
        await this.raceResult.writeField(
          config,
          entry.person.bib,
          fieldName,
          mine,
        );
      }
    }

    // Resolved through the band the athlete is actually wearing, so a claim made
    // from the roster comes back with the same shape as one made from a scan —
    // including the doubles partner, which the tablet needs either way.
    const lookupCode = entry.person.wristbandCode || code || entry.person.bib;
    return {
      ...(await this.resolveWristband(eventId, lookupCode, mine)),
      claimedBy: mine,
      resumed,
      // The colours this athlete has to memorise, assigned here.
      //
      // It has to come from the server: `generateCognitiveSequence` is what
      // decides a sequence is legal — ten colours, all four present, none three
      // times in a row — and the submission is validated against exactly that
      // rule. A tablet generating its own would be a second copy of the rule in
      // a second language, and a race that fails validation after it has been
      // run is a race nobody can hand in.
      //
      // Assigned per claim rather than stored: nothing keeps races any more, so
      // a resumed claim gets a new sequence. That only matters if the athlete
      // has already memorised one — which is why the tablet keeps the sequence
      // it was first given and ignores this on a resume.
      cognitiveSequence: generateCognitiveSequence(),
    };
  }

  /**
   * Claims both halves of a doubles pair, by the two bands scanned.
   *
   * Sequential rather than parallel, and deliberately: the second claim can
   * refuse because another judge holds that partner, and if it does the first
   * one is handed back. A pair half-claimed is worse than one not claimed at
   * all — the other judge would find their athlete taken by a race that never
   * started.
   */
  async claimPair(eventId: string, codes: string[], judgeStaffId: string) {
    const wanted = codes.map((code) => String(code ?? '').trim()).filter(Boolean);
    if (wanted.length !== 2)
      throw new BadRequestException('Scan two different partner wristbands');
    if (wanted[0].toLowerCase() === wanted[1].toLowerCase())
      throw new BadRequestException('Scan two DIFFERENT partner wristbands');

    const first = await this.claim(eventId, { code: wanted[0] }, judgeStaffId);
    if (!first?.participant)
      throw new BadRequestException(
        `No athlete is carrying Wristband ID ${wanted[0]}`,
      );
    const firstBib = first.participant.bib;

    try {
      const second = await this.claim(eventId, { code: wanted[1] }, judgeStaffId);
      if (!second)
        throw new BadRequestException(
          `No athlete is carrying Wristband ID ${wanted[1]}`,
        );
      return {
        ...first,
        partner: second.participant,
        claimedBy: judgeStaffId,
        resumed: first.resumed && second.resumed,
      };
    } catch (error) {
      // Hand the first one back, best effort. Failing to is not worth turning
      // a partner conflict into a failed claim as well.
      await this.release(eventId, firstBib, judgeStaffId).catch(() => undefined);
      throw error;
    }
  }

  /**
   * Hands an athlete back without recording a race.
   *
   * Clears `judgedby` so somebody else can pick them up. Only the judge holding
   * them may do it: releasing another judge's athlete mid-race would put two
   * tablets on one person with neither of them knowing.
   */
  async release(eventId: string, bib: string, judgeStaffId: string) {
    const config = await this.raceResult.loadConfig(eventId);
    const entry = await this.raceResult.fetchAthlete(config, eventId, bib, {
      fresh: true,
    });
    if (!entry) throw new BadRequestException(`BIB ${bib} was not found`);

    const holder = entry.person.judgedBy.trim();
    const mine = judgeStaffId.trim();
    if (holder && holder.toLowerCase() !== mine.toLowerCase()) {
      throw new ConflictException(
        `BIB ${bib} is held by ${holder}, not by you.`,
      );
    }

    // Cleared everywhere it was set, or a mirrored column would go on naming a
    // judge who has already handed the athlete back.
    for (const fieldName of resolveUpdateFields(
      config.updateMapping,
      'judgedby',
    )) {
      await this.raceResult.writeField(config, entry.person.bib, fieldName, '');
    }
    return { bib: entry.person.bib, released: true };
  }

  /** The athlete as the tablet needs them. `id` is the bib: with nothing
   *  stored, the bib is the only identifier that means anything. */
  private shape(entry: CheckinRosterEntry, judgeIdentity = '') {
    return {
      id: entry.person.bib,
      bib: entry.person.bib,
      name: entry.person.name,
      category: entry.person.category,
      contestId: entry.person.contestId,
      wave: entry.person.wave,
      club: entry.person.club,
      // The feed carries `DateOfBirth` and the import has parsed it into
      // `person.dateOfBirth` since this util was written — it just never made
      // it into the shape, so the tablet's `Participant.dateOfBirth` (which has
      // always read this key) was empty for every athlete resolved by band.
      // ISO `YYYY-MM-DD`, or '' where the roster has no usable date:
      // `normalizeDateOfBirth` refuses to guess at anything else.
      dateOfBirth: entry.person.dateOfBirth,
      wristbandId: entry.person.wristbandCode,
      transponder1: entry.person.transponderCode,
      stage2Ready: Boolean(entry.stages.STAGE_2_TRANSPONDER),
      judgedBy: entry.person.judgedBy,
      completed: entry.person.completed,
      // The label the roster and the scan result both show.
      //
      // 'Yours' and 'On course' are opposite instructions and the difference is
      // WHO IS ASKING — so the caller's identity has to reach here. Reporting a
      // judge's own athlete as 'On course' is not a cosmetic slip: the scanner
      // refuses that outright, so a judge could not rescan an athlete they were
      // already running, and a doubles pairing could never be completed once
      // either partner had been claimed.
      //
      // Completed still wins over both: a finished athlete is nobody's to
      // resume.
      status: entry.person.completed
        ? 'Completed'
        : !entry.person.judgedBy.trim()
          ? 'Ready'
          : entry.person.judgedBy.trim().toLowerCase() ===
              judgeIdentity.trim().toLowerCase()
            ? 'Yours'
            : 'On course',
    };
  }
}
