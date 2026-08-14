export type CheckinStageType = 'STAGE_1_WRISTBAND' | 'STAGE_2_TRANSPONDER';

export function raceResultLocalTimestamp(value: Date, timeZone: string) {
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

export function isDoublesContest(category: string) {
  return /\bdoubles?\b/i.test(category);
}

export function teamWarning(
  participant: { category: string; club: string },
  teammates: Array<{ id: string }>,
) {
  if (!isDoublesContest(participant.category)) return null;
  if (!participant.club.trim()) return 'Doubles team has no club identifier';
  if (teammates.length === 0) return 'Doubles teammate was not found';
  if (teammates.length > 1) return 'More than two athletes share this Doubles club';
  return null;
}
