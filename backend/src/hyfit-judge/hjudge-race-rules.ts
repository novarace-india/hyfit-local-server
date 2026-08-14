import { randomInt } from 'node:crypto';

export const cognitiveSequenceLength = 10;
export const cognitiveColors = new Set<string>(['R', 'G', 'B', 'Y']);

export function generateCognitiveSequence(
  choose: (maximum: number) => number = randomInt,
) {
  const colors = [...cognitiveColors];
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const sequence = Array.from(
      { length: cognitiveSequenceLength },
      () => colors[choose(colors.length)],
    );
    if (new Set(sequence).size !== colors.length) continue;
    if (
      sequence.some(
        (value, index) =>
          index >= 2 &&
          value === sequence[index - 1] &&
          value === sequence[index - 2],
      )
    )
      continue;
    return sequence;
  }
  throw new Error('Unable to generate a valid cognitive sequence');
}

export function chooseUniqueCognitiveSequence(
  used: ReadonlySet<string>,
  generate: () => string[] = generateCognitiveSequence,
) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidate = generate();
    if (!isValidCognitiveSequence(candidate)) continue;
    if (!used.has(candidate.join(''))) return candidate;
  }
  throw new Error('Unable to assign a unique cognitive sequence');
}

export function isValidCognitiveSequence(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length === cognitiveSequenceLength &&
    value.every((color) => cognitiveColors.has(String(color))) &&
    new Set(value).size === cognitiveColors.size &&
    !value.some(
      (color, index) =>
        index >= 2 && color === value[index - 1] && color === value[index - 2],
    )
  );
}

export function scoreSequence(response: string[], sequence: string[]) {
  const correctCount = response.filter(
    (value, index) => value === sequence[index],
  ).length;
  return {
    correctCount,
    percentage: Math.round((correctCount / sequence.length) * 100),
  };
}

export function cognitiveAdjustment(response: string[], sequence: string[]) {
  const score = scoreSequence(response, sequence);
  return {
    ...score,
    penaltySeconds: score.percentage <= 60 ? 30 : 0,
    bonusSeconds: score.percentage === 100 ? 30 : 0,
  };
}

const bearCrawlPenaltyExemptContests = new Set(['1', '2', '3', '4', '9']);

export function allowsBearCrawlPenalty(contestId: string | null | undefined) {
  return !bearCrawlPenaltyExemptContests.has(String(contestId ?? '').trim());
}

// Station 2 (Farmer's Carry) offers an Incomplete Laps penalty only for these
// contests — an allow-list, unlike the Bear Crawl exemption above, because
// most contests should never see the control at all. Must stay byte-for-byte
// in step with `_incompleteLapsPenaltyContests` in
// `hyfit_judge/lib/models/race_format.dart`: that is where the control is
// shown to the judge, this is what accepts the race it produces, and the two
// drifting apart is what rejected every Station 2 penalty submitted after the
// tablet added the control (the whole race, not just the field).
const incompleteLapsPenaltyContests = new Set([
  '5',
  '6',
  '7',
  '8',
  '10',
  '11',
  '12',
  '13',
]);

export function allowsIncompleteLapsPenalty(
  contestId: string | null | undefined,
) {
  return incompleteLapsPenaltyContests.has(String(contestId ?? '').trim());
}

/**
 * How many seconds a `penalty` outcome is worth at a given station, for a
 * given contest. Zero means this station/contest combination offers no
 * penalty at all — the single source of truth `validateStationOutcome` checks
 * submissions against, mirroring `penaltySecondsForStationOutcome()` in
 * `race_format.dart`.
 */
export function penaltySecondsForStationOutcome(
  stationNumber: number,
  contestId: string | null | undefined,
) {
  if (stationNumber === 3 && allowsBearCrawlPenalty(contestId)) return 10;
  if (stationNumber === 2 && allowsIncompleteLapsPenalty(contestId)) return 120;
  return 0;
}

export function validateStationOutcome(
  stationNumber: number,
  outcome: string,
  penaltySeconds: number,
  _note: string,
  contestId = '',
) {
  if (outcome === 'ics') return penaltySeconds === 0;
  if (outcome === 'penalty') {
    const allowed = penaltySecondsForStationOutcome(stationNumber, contestId);
    return allowed > 0 && penaltySeconds === allowed;
  }
  return outcome === 'none' && penaltySeconds === 0;
}

type TimingBoundary = { stageId: string; boundaryAt: string | Date };

export const timingBackupFieldKeys = [
  'cognitivememorisetime',
  'run1time',
  'station1time',
  'run2time',
  'station2time',
  'run3time',
  'station3time',
  'run4time',
  'station4time',
  'run5time',
  'station5time',
  'run6time',
  'station6time',
  'cognitiverecalltime',
  'tyrefliprecalltime',
  'recalltofinishtime',
  'totalracetime',
] as const;

export type TimingBackupFieldKey = (typeof timingBackupFieldKeys)[number];

/** All RR14 timing backups, in milliseconds until the delivery boundary. */
export function timingBackupValues(
  splits: TimingBoundary[],
  raceMode: 'single' | 'doubles' | string,
): Record<TimingBackupFieldKey, number | null> {
  const boundaries = new Map<string, number>();
  for (const split of splits) {
    const milliseconds = new Date(split.boundaryAt).getTime();
    if (Number.isFinite(milliseconds))
      boundaries.set(split.stageId, milliseconds);
  }
  const between = (start: string, finish: string) => {
    const from = boundaries.get(start);
    const to = boundaries.get(finish);
    return from === undefined || to === undefined
      ? null
      : Math.max(0, to - from);
  };
  const manualStart = raceMode === 'doubles' ? 'team_start' : 'race_start';

  return {
    cognitivememorisetime: between('race_start', 'cognitive_memorise'),
    run1time: between(manualStart, 'run_1'),
    station1time: between('run_1', 'station_1'),
    run2time: between('station_1', 'run_2'),
    station2time: between('run_2', 'station_2'),
    run3time: between('station_2', 'run_3'),
    station3time: between('run_3', 'station_3'),
    run4time: between('station_3', 'run_4'),
    station4time: between('run_4', 'station_4'),
    run5time: between('station_4', 'run_5'),
    station5time: between('run_5', 'station_5'),
    run6time: between('station_5', 'run_6'),
    station6time: between('run_6', 'station_6'),
    cognitiverecalltime: between('station_6', 'cognitive_recall'),
    tyrefliprecalltime: between('run_6', 'cognitive_recall'),
    recalltofinishtime: between('cognitive_recall', 'finish_line'),
    totalracetime: between(manualStart, 'finish_line'),
  };
}

export const timeOfDayFieldKeys = [
  'starttod',
  'run1tod',
  'station1tod',
  'run2tod',
  'station2tod',
  'run3tod',
  'station3tod',
  'run4tod',
  'station4tod',
  'run5tod',
  'station5tod',
  'run6tod',
  'station6tod',
  'cognitiverecalltod',
  'finishtod',
] as const;

export type TimeOfDayFieldKey = (typeof timeOfDayFieldKeys)[number];

/**
 * Which boundary each time-of-day field reports.
 *
 * `starttod` is the exception and is resolved per race, because the start of a
 * doubles race is the team crossing the line rather than the individual gun —
 * exactly as `timingBackupValues` picks its `manualStart`. The two must agree:
 * an elapsed `totalracetime` measured from one start and a `starttod` printed
 * from the other would not add up, and the pair of them is what anyone
 * reconciling a result against a mat will subtract.
 */
const timeOfDayBoundaries: Record<
  Exclude<TimeOfDayFieldKey, 'starttod'>,
  string
> = {
  run1tod: 'run_1',
  station1tod: 'station_1',
  run2tod: 'run_2',
  station2tod: 'station_2',
  run3tod: 'run_3',
  station3tod: 'station_3',
  run4tod: 'run_4',
  station4tod: 'station_4',
  run5tod: 'run_5',
  station5tod: 'station_5',
  run6tod: 'run_6',
  station6tod: 'station_6',
  cognitiverecalltod: 'cognitive_recall',
  finishtod: 'finish_line',
};

/**
 * A clock time in the event's own zone, to milliseconds.
 *
 * ⚠ THE FORMAT IS AN ASSUMPTION — `HH:mm:ss.SSS`, matching the three decimals
 * the elapsed fields already use. Confirm it against the event before relying
 * on it: `savevalue` answers 200 for a value RaceResult cannot parse just as it
 * does for a field that does not exist, so a wrong format is silent.
 *
 * The event's zone, not the server's: a tablet sends UTC and the box this runs
 * on may be anywhere, but the only reading of "time of day" that means anything
 * is the one on the wall the athlete ran under.
 */
export function raceResultTimeOfDay(milliseconds: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(milliseconds));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? '';
  // Taken off the epoch rather than the formatter, which has no milliseconds
  // field — and wrapped, so an instant before 1970 cannot produce a negative
  // fraction.
  const fraction = String(((milliseconds % 1000) + 1000) % 1000).padStart(
    3,
    '0',
  );
  return `${part('hour')}:${part('minute')}:${part('second')}.${fraction}`;
}

/**
 * Every boundary as a time of day, for the boundaries this race recorded.
 *
 * A boundary that was never tapped comes back as `''`, which CLEARS the field
 * on the RaceResult side — the same choice `timingBackupValues` makes for a
 * duration it cannot compute. Re-submitting a corrected race has to be able to
 * take a value away, not only overwrite it.
 */
export function timeOfDayValues(
  splits: TimingBoundary[],
  raceMode: 'single' | 'doubles',
  timeZone: string,
): Record<TimeOfDayFieldKey, string> {
  const boundaries = new Map<string, number>();
  for (const split of splits) {
    const milliseconds = new Date(split.boundaryAt).getTime();
    if (Number.isFinite(milliseconds))
      boundaries.set(split.stageId, milliseconds);
  }

  const at = (stageId: string) => {
    const milliseconds = boundaries.get(stageId);
    return milliseconds === undefined
      ? ''
      : raceResultTimeOfDay(milliseconds, timeZone);
  };

  const manualStart = raceMode === 'doubles' ? 'team_start' : 'race_start';
  const values = { starttod: at(manualStart) } as Record<
    TimeOfDayFieldKey,
    string
  >;
  for (const [key, stageId] of Object.entries(timeOfDayBoundaries)) {
    values[key as TimeOfDayFieldKey] = at(stageId);
  }
  return values;
}

export function finalSegmentTimings(splits: TimingBoundary[]) {
  const boundary = (stageId: string) => {
    const match = [...splits]
      .reverse()
      .find((split) => split.stageId === stageId);
    if (!match) return null;
    const milliseconds = new Date(match.boundaryAt).getTime();
    return Number.isFinite(milliseconds) ? milliseconds : null;
  };

  const tyreFlipStartedAt = boundary('run_6');
  const recallCompletedAt = boundary('cognitive_recall');
  const finishedAt = boundary('finish_line');

  return {
    tyreFlipRecallMs:
      tyreFlipStartedAt !== null && recallCompletedAt !== null
        ? Math.max(0, recallCompletedAt - tyreFlipStartedAt)
        : null,
    recallToFinishMs:
      recallCompletedAt !== null && finishedAt !== null
        ? Math.max(0, finishedAt - recallCompletedAt)
        : null,
    recallCompletedAt:
      recallCompletedAt !== null
        ? new Date(recallCompletedAt).toISOString()
        : null,
  };
}
