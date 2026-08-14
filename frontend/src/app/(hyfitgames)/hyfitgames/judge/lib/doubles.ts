export const doublesContests = {
  '9': 'Bloodline Doubles',
  '10': 'Male Doubles',
  '11': 'Female Doubles',
  '12': 'Mixed Doubles',
} as const;

export type DoublesContestId = keyof typeof doublesContests;

export function isDoublesContestId(contestId: unknown): contestId is DoublesContestId {
  return typeof contestId === 'string' &&
    Object.prototype.hasOwnProperty.call(doublesContests, contestId);
}

export function normalizedTeamClub(club: unknown) {
  return String(club ?? '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en');
}

export function sameDoublesTeam(
  first: { id: string; contestId: string; club: string },
  second: { id: string; contestId: string; club: string },
) {
  const club = normalizedTeamClub(first.club);
  return first.id !== second.id &&
    isDoublesContestId(first.contestId) &&
    first.contestId === second.contestId &&
    Boolean(club) &&
    club === normalizedTeamClub(second.club);
}
