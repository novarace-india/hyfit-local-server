export type Participant = {
  id: string;
  bib: string;
  name: string;
  category: string;
  contestId: string;
  wave: string;
  gender: string;
  dateOfBirth: string;
  club: string;
  avatar: string;
  /* 'Yours' is an athlete this judge already holds — an active race to walk
     back into, not a conflict. 'On course' is another judge's, and stays
     untouchable. 'Completed' has already raced: still findable by BIB, so a
     judge can check what happened, but never offered up as work to do. */
  status: 'Ready' | 'On course' | 'Yours' | 'Completed';
};

export type ParticipantSync = {
  source: 'raceresult' | 'demo' | 'device';
  fetchedAt: string;
  expiresAt: string;
  rejectedCount: number;
  stale: boolean;
};

export type ParticipantResponse = {
  participants: Participant[];
  sync: ParticipantSync;
};

export function participantInitials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('') || '\u2014';
}

export function searchParticipants(participants: Participant[], query: string) {
  const normalizedQuery = query.trim().toLowerCase();
  // With no query the list is a shortlist, so anyone this judge is already
  // holding goes at the front of it. Otherwise a judge coming back to the
  // roster — after a reload, or after stepping away — would have to search by
  // BIB for the athlete they are in the middle of judging.
  if (!normalizedQuery) {
    const mine = participants.filter((participant) => participant.status === 'Yours');
    // An athlete who has finished is not upcoming. Leaving them in the
    // shortlist puts a race that already happened at the top of the list a
    // judge picks their next athlete from.
    const rest = participants.filter(
      (participant) =>
        participant.status !== 'Yours' && participant.status !== 'Completed',
    );
    return [...mine, ...rest].slice(0, Math.max(3, mine.length));
  }

  return participants
    .filter((participant) => `${participant.name} ${participant.bib}`.toLowerCase().includes(normalizedQuery))
    .sort((left, right) => {
      const leftExact = left.bib.toLowerCase() === normalizedQuery ? 1 : 0;
      const rightExact = right.bib.toLowerCase() === normalizedQuery ? 1 : 0;
      return rightExact - leftExact;
    });
}

export function parseScannedBib(value: string) {
  const bib = value.trim();
  return /^\d+$/.test(bib) ? bib : null;
}

export function findParticipantByScannedBib(participants: Participant[], value: string) {
  const bib = parseScannedBib(value);
  if (!bib) return null;
  return participants.find((participant) => participant.bib === bib) ?? null;
}
