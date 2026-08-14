import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { HjudgeRaceResultService } from './hjudge-raceresult.service';
import {
  cognitiveAdjustment,
  cognitiveSequenceLength,
  isValidCognitiveSequence,
  timeOfDayFieldKeys,
  timeOfDayValues,
  timingBackupFieldKeys,
  timingBackupValues,
  validateStationOutcome,
  type TimeOfDayFieldKey,
  type TimingBackupFieldKey,
} from '../hjudge-race-rules';
import {
  resolveUpdateFields,
  stationUpdateFieldKey,
  type UpdateFieldKey,
} from '../hjudge-update-mapping.util';

/**
 * A finished race, turned into RaceResult field values and pushed.
 *
 * The judge tablet owns the race while it is being run — the stages, the
 * boundary timestamps, the station outcomes, the recall taps — and hands the
 * whole thing here to be scored and delivered. Nothing is stored: there is no
 * race session, no split row, no outbox. The submission IS the record, and
 * RaceResult is where it lands.
 *
 * The derivation deliberately does NOT move to the tablet with the state.
 * `timingBackupValues` and the station-outcome rules are what decide an
 * athlete's official time, and two copies of that in two languages is the
 * failure this codebase has paid for four times already. The tablet sends what
 * it observed; the rules that turn observations into a result stay here.
 */

export interface RaceBoundary {
  stageId: string;
  boundaryAt: string;
}

export interface StationOutcomeInput {
  stationNumber: number;
  outcome: 'none' | 'penalty' | 'ics';
  penaltySeconds?: number;
  note?: string;
}

export interface RaceSubmission {
  /** Every athlete the result belongs to — one for a solo, two for a pair. */
  bibs: string[];
  raceMode: 'single' | 'doubles';
  contestId?: string;
  boundaries: RaceBoundary[];
  stationOutcomes?: StationOutcomeInput[];
  cognitive?: { sequence: string[]; response: string[] };
  athleteNote?: string;
  /**
   * An override for the completion status.
   *
   * Left unset by the tablet in the normal case: finishing a race IS the thing
   * that marks an athlete completed, so the value below is written on every
   * submission rather than waiting to be asked for. This exists for the cases
   * that are not a normal finish and will need a different value once those
   * values are known.
   */
  status?: string;
}

/**
 * What `Status` is set to when a race is handed in.
 *
 * `Status` is RaceResult's BUILT-IN participant status, and its vocabulary is
 * fixed, not free text — `getParticipantStatus` in
 * `publicRoutes/utils/live-helpers.ts` (which every live-results and
 * statistics view reads) is `0 = Completed, 1 = OOC, 2 = DSQ, 3 = DNF,
 * 4 = DNS`. Handing a race in is what marks an athlete completed, so `0` goes
 * out with every submission UNLESS the race itself says otherwise: a station
 * marked ICS means the athlete never finished the course, i.e. `1` (OOC) —
 * see `RACE_OOC_STATUS` below and where it is chosen in `fieldsFor`.
 *
 * The field name itself is overridable per event in the update mapping; these
 * values are not, and deliberately live in one place for that reason.
 */
const RACE_COMPLETED_STATUS = '0';

/** See `RACE_COMPLETED_STATUS` — set instead of it when any station is ICS. */
const RACE_OOC_STATUS = '1';

/**
 * What `statusofathelet` is set to when a race is handed in.
 *
 * NOT the same vocabulary as `Status`, and that is the whole point of it being
 * a separate constant. `statusofathelet` is a CUSTOM field on the RaceResult
 * side, and this app defines its meaning: a plain yes/no flag for "this
 * athlete's race is done", read back off the participant feed by
 * `buildCheckinRoster` through `readRecordFlag` — where `1` is done and `0` is
 * still to run.
 *
 * The two were written the same value until now, which inverted the flag the
 * moment `RACE_COMPLETED_STATUS` was corrected to `'0'`: a clean finisher was
 * stamped `statusofathelet = 0`, read back as NOT completed, and so stayed
 * claimable — while an OOC athlete got `1` and read as done. That flag is the
 * only thing standing between a finished race and a second judge re-running it
 * (`HjudgeJudgeService.claim`), so the inversion handed every clean finisher
 * back to the roster as Ready.
 *
 * `1` for EVERY submission, including OOC and DSQ: the question this field
 * answers is "has this athlete's race been handed in", not "did they finish
 * well". A station marked ICS still ends the race, and re-running that athlete
 * would overwrite the real record field by field.
 */
const RACE_HANDED_IN = '1';

/** One RaceResult field, already resolved to that event's spelling. */
interface FieldWrite {
  key: UpdateFieldKey;
  value: string;
}

@Injectable()
export class HjudgeRaceSubmitService {
  private readonly logger = new Logger(HjudgeRaceSubmitService.name);

  constructor(private readonly rr: HjudgeRaceResultService) {}

  /** Seconds, to three decimals — RaceResult's format for every timing field. */
  private seconds(milliseconds: number | null) {
    return milliseconds === null ? '' : (milliseconds / 1000).toFixed(3);
  }

  private validate(data: RaceSubmission) {
    const bibs = (data.bibs ?? [])
      .map((bib) => String(bib ?? '').trim())
      .filter(Boolean);
    if (!bibs.length) throw new BadRequestException('At least one BIB is required');
    if (bibs.some((bib) => !/^\d+$/.test(bib)))
      throw new BadRequestException('Every BIB must be numeric');
    if (data.raceMode === 'doubles' && bibs.length !== 2)
      throw new BadRequestException('A doubles race is two athletes');
    if (data.raceMode !== 'doubles' && bibs.length !== 1)
      throw new BadRequestException('A solo race is one athlete');

    if (!Array.isArray(data.boundaries) || !data.boundaries.length)
      throw new BadRequestException('A race with no timings cannot be submitted');
    for (const boundary of data.boundaries) {
      if (!boundary?.stageId || Number.isNaN(Date.parse(boundary.boundaryAt)))
        throw new BadRequestException(
          `"${boundary?.stageId ?? 'unknown'}" has no readable boundary time`,
        );
    }

    // The station rules are the reason a penalty cannot simply be typed in: a
    // 10-second Bear Crawl penalty is legal, a 10-second Tyre Flip penalty is
    // not, and an ICS carries no seconds at all.
    for (const outcome of data.stationOutcomes ?? []) {
      const seconds = Number(outcome.penaltySeconds ?? 0);
      if (
        !validateStationOutcome(
          Number(outcome.stationNumber),
          String(outcome.outcome),
          seconds,
          String(outcome.note ?? ''),
          String(data.contestId ?? ''),
        )
      ) {
        throw new BadRequestException(
          `Station ${outcome.stationNumber} cannot be recorded as ${outcome.outcome}${seconds ? ` with ${seconds}s` : ''} in this contest`,
        );
      }
    }

    // Strict, and worth being strict about — the sequence is what the recall is
    // scored against. But the message has to name the problem, because this
    // rejects the WHOLE race: a tablet sending a malformed block loses every
    // split and every station with it, and "the cognitive sequence is invalid"
    // gave nobody a way to find out why.
    if (data.cognitive) {
      const sequence = data.cognitive.sequence;
      if (!isValidCognitiveSequence(sequence)) {
        const seen = Array.isArray(sequence) ? sequence : [];
        throw new BadRequestException(
          `The cognitive sequence is invalid (${seen.length} colours: ${
            seen.join('') || 'none'
          }). It must be ${cognitiveSequenceLength} of R/G/B/Y, all four present, none three in a row. Omit the cognitive block entirely if no recall was run.`,
        );
      }
      if (!Array.isArray(data.cognitive.response))
        throw new BadRequestException('The cognitive response is invalid');
    }

    return bibs;
  }

  /** Everything this race writes, as our field keys. */
  private fieldsFor(data: RaceSubmission, timeZone: string): FieldWrite[] {
    const writes: FieldWrite[] = [];

    const timings = timingBackupValues(data.boundaries, data.raceMode);
    for (const key of timingBackupFieldKeys as readonly TimingBackupFieldKey[]) {
      writes.push({ key, value: this.seconds(timings[key]) });
    }

    // The same boundaries again, as clock times rather than gaps. Derived here
    // from what the tablet already sends, so no tablet needs reinstalling to
    // start filling these in.
    const timesOfDay = timeOfDayValues(
      data.boundaries,
      data.raceMode,
      timeZone,
    );
    for (const key of timeOfDayFieldKeys as readonly TimeOfDayFieldKey[]) {
      writes.push({ key, value: timesOfDay[key] });
    }

    for (const outcome of data.stationOutcomes ?? []) {
      const station = Number(outcome.stationNumber);
      // Both fields are written for every station that was judged, including
      // the clean ones — leaving one unwritten would let a previous attempt's
      // value stand.
      //
      // ZERO, not blank. These are numeric fields on the RaceResult side and
      // they are summed there; a blank is not a number, so it either breaks the
      // total or renders as an empty cell that reads like "not judged" rather
      // than "judged, nothing to report". An ICS carries no seconds by rule
      // (validateStationOutcome enforces it), so its penalty is a real 0 too.
      writes.push({
        key: stationUpdateFieldKey(station, 'penalty'),
        value:
          outcome.outcome === 'penalty'
            ? String(Number(outcome.penaltySeconds ?? 0))
            : '0',
      });
      writes.push({
        key: stationUpdateFieldKey(station, 'ics'),
        value: outcome.outcome === 'ics' ? '1' : '0',
      });
      // The judge's own words about that station, written for every judged
      // station including the empty ones — clearing a note has to actually
      // clear it, and an unwritten field would leave a previous attempt's
      // standing. Blank here, not zero: an empty note is empty, not nothing.
      writes.push({
        key: stationUpdateFieldKey(station, 'note'),
        value: String(outcome.note ?? ''),
      });
    }

    if (data.cognitive) {
      const { penaltySeconds, bonusSeconds } = cognitiveAdjustment(
        data.cognitive.response,
        data.cognitive.sequence,
      );
      writes.push({ key: 'cognitiveskillpenalty', value: String(penaltySeconds) });
      writes.push({ key: 'cognitiveskillbonus', value: String(bonusSeconds) });
      // The raw sequence and response themselves, not just their score — ten
      // letters each, e.g. "RGBYRGBYRG" — so the record can be re-checked or
      // disputed against what was actually shown and tapped, not only the
      // penalty/bonus `cognitiveAdjustment` derived from them.
      writes.push({
        key: 'cognitivepattershown',
        value: data.cognitive.sequence.join(''),
      });
      writes.push({
        key: 'cognitiverecalled',
        value: data.cognitive.response.join(''),
      });
    }

    if (data.athleteNote !== undefined) {
      writes.push({ key: 'athletenotes', value: String(data.athleteNote ?? '') });
    }
    // Handing the race in is what settles the athlete's status, so both status
    // fields are written every time rather than only when the tablet asks. An
    // explicit status on the submission overrides the derivation, for a finish
    // that is not a normal one. Otherwise: any station recorded ICS makes the
    // whole race OOC, exactly as the judge tablet's own OOC banner already
    // shows the judge — see `RACE_COMPLETED_STATUS`.
    const hasIcs = (data.stationOutcomes ?? []).some(
      (outcome) => outcome.outcome === 'ics',
    );
    const completed = data.status
      ? String(data.status)
      : hasIcs
        ? RACE_OOC_STATUS
        : RACE_COMPLETED_STATUS;
    writes.push({ key: 'status', value: completed });
    // The completion FLAG, not a copy of the status above — see
    // `RACE_HANDED_IN`. This is what the roster reads to decide whether an
    // athlete may be claimed again.
    writes.push({ key: 'statusofathelet', value: RACE_HANDED_IN });

    return writes;
  }

  /**
   * Scores the race and writes it to RaceResult, for every athlete on it.
   *
   * Sequential rather than parallel: RaceResult is one self-hosted server being
   * written to by every tablet on the course at once, and a race is ~40 fields.
   * Failing part-way leaves the athlete's earlier fields written and the rest
   * not — which is recoverable, because every write sets a value rather than
   * adding one, so re-submitting the same race repairs it.
   */
  async submit(eventId: string, data: RaceSubmission, judgeStaffId = '') {
    const bibs = this.validate(data);
    const config = await this.rr.loadConfig(eventId);
    if (!this.rr.canWrite(config)) {
      throw new BadRequestException(
        'This event has no RaceResult update endpoint. Set one in Operations before judging.',
      );
    }

    const writes = this.fieldsFor(data, config.timeZone);

    // Who handed this race in, stamped at the moment it lands.
    //
    // `judgedby` is written at claim too, but a claim can be resumed, taken
    // over or predate a tablet swap — the submission is the act that produces
    // the result, so it is the one whose author the record should carry.
    //
    // Taken from the SESSION, never the payload: attribution a client can set
    // is not attribution.
    if (judgeStaffId.trim()) {
      writes.push({ key: 'judgedby', value: judgeStaffId.trim() });
    }

    const written: string[] = [];

    for (const bib of bibs) {
      for (const write of writes) {
        // Usually one field, and more than one where the event mirrors a value
        // into a second column.
        for (const fieldName of resolveUpdateFields(
          config.updateMapping,
          write.key,
        )) {
          await this.rr.writeField(config, bib, fieldName, write.value);
          written.push(`${bib}:${fieldName}`);
        }
      }
    }

    // The resolved field NAMES, not just a count. `savevalue` answers 200 with
    // a body of `0` for a field the event does not have, so a name that is
    // wrong is invisible at the HTTP layer — this line is the only place it
    // becomes findable.
    this.logger.log(
      `Race submitted for BIB ${bibs.join(' + ')} — ${writes.length} fields each: ` +
        writes
          .flatMap((write) =>
            resolveUpdateFields(config.updateMapping, write.key),
          )
          .join(', '),
    );

    return {
      bibs,
      fieldsWritten: writes.length,
      totalWrites: written.length,
      state: 'completed' as const,
    };
  }
}
