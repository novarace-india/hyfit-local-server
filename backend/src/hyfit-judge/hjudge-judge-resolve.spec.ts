import { HjudgeJudgeService } from './services/hjudge-judge.service';
import { buildCheckinRoster } from './hjudge-checkin-rr.util';

/* GET /hyfit-judge/judge/resolve — the judge app's only way to find an athlete.
 *
 * Everything it answers with now comes from the RaceResult start list: the
 * identity, the wristband, the transponder, and the doubles partner. The
 * database is not consulted at all, because a race is no longer stored. */

const EVENT = '11111111-1111-1111-1111-111111111111';

const row = (over: Record<string, unknown> = {}) => ({
  Bib: 101,
  'First Name': 'Asha',
  Lastname: 'Menon',
  Contest: 'Female Open',
  ContestID: 6,
  Gender: 'Female',
  Club: 'Fitness Club 19',
  DateOfBirth: '2000-04-10',
  Wave: '09:20',
  TimeSlot: '09:00 - 11:00',
  ContestDate: '2026-08-16',
  Transponder1: 'TR-8801',
  wristbandid: 'WB-5502',
  ...over,
});

const mapping = { listPath: '', bib: 'bib', contestId: 'ContestID' };
const update = { wristband: 'wristbandID', transponder1: 'Transponder1' };

/** A RaceResult service backed by an in-memory start list. */
const fakeRaceResult = (rows: unknown[]) => {
  const roster = buildCheckinRoster(rows, mapping, update);
  const assetKey = (v: unknown) =>
    String(v ?? '').trim().toLowerCase().replace(/^0+/, '') ||
    String(v ?? '').trim().toLowerCase();
  return {
    findByCode: jest.fn(async (_eventId: string, code: string) => {
      const wanted = assetKey(code);
      if (!wanted) return null;
      const byWristband = roster.entries.find(
        (e) => assetKey(e.person.wristbandCode) === wanted,
      );
      const match =
        byWristband ??
        roster.entries.find((e) => assetKey(e.person.transponderCode) === wanted);
      if (!match) return null;
      return {
        equipment: {
          bib: match.person.bib,
          wristbandCode: match.person.wristbandCode,
          transponderCode: match.person.transponderCode,
          stage2Ready: Boolean(match.stages.STAGE_2_TRANSPONDER),
        },
        matchedAssetType: byWristband ? 'wristband' : 'transponder1',
        entry: match,
        roster,
      };
    }),
  } as any;
};

describe('resolving an athlete by check-in code', () => {
  it('finds an athlete by their wristband', async () => {
    const service = new HjudgeJudgeService(fakeRaceResult([row()]));
    const result = await service.resolveWristband(EVENT, 'WB-5502');

    expect(result?.participant).toMatchObject({
      bib: '101',
      name: 'Asha Menon',
      wristbandId: 'WB-5502',
      transponder1: 'TR-8801',
    });
    expect(result?.matchedAssetType).toBe('wristband');
  });

  it('finds the same athlete by their transponder', async () => {
    const service = new HjudgeJudgeService(fakeRaceResult([row()]));
    const result = await service.resolveWristband(EVENT, 'TR-8801');

    expect(result?.participant.bib).toBe('101');
    expect(result?.matchedAssetType).toBe('transponder1');
    // A doubles submission pairs on wristband codes, so a partner found by
    // transponder still has to hand back something that pairing can use.
    expect(result?.scannedWristbandCode).toBe('WB-5502');
  });

  it('falls back to the searched code for an athlete with no wristband', async () => {
    const service = new HjudgeJudgeService(
      fakeRaceResult([row({ wristbandid: '' })]),
    );
    const result = await service.resolveWristband(EVENT, 'TR-8801');
    expect(result?.scannedWristbandCode).toBe('TR-8801');
  });

  it('reports a code nobody is carrying as nothing found', async () => {
    const service = new HjudgeJudgeService(fakeRaceResult([row()]));
    expect(await service.resolveWristband(EVENT, 'NOPE')).toBeNull();
  });

  // The hold lives on the athlete's own record now, so resolve reports who has
  // them and leaves the caller to decide what that means — a roster labels it
  // 'Yours' or 'On course' by comparing against the judge asking.
  it('reports nobody holding a free athlete', async () => {
    const service = new HjudgeJudgeService(fakeRaceResult([row()]));
    const result = await service.resolveWristband(EVENT, 'WB-5502');
    expect(result?.participant.judgedBy).toBe('');
  });

  it('reports the judge already running an athlete', async () => {
    const service = new HjudgeJudgeService(
      fakeRaceResult([row({ jugedby: 'JDG-07' })]),
    );
    const result = await service.resolveWristband(EVENT, 'WB-5502');
    expect(result?.participant.judgedBy).toBe('JDG-07');
  });

  describe('doubles', () => {
    const pair = [
      row({ Bib: 201, Contest: 'Mixed Doubles', ContestID: 12, Club: 'T-1', wristbandid: 'W-201' }),
      row({ Bib: 202, Contest: 'Mixed Doubles', ContestID: 12, Club: 'T-1', wristbandid: 'W-202', 'First Name': 'Ravi' }),
    ];

    it('hands back the partner sharing the club', async () => {
      const service = new HjudgeJudgeService(fakeRaceResult(pair));
      const result = await service.resolveWristband(EVENT, 'W-201');
      expect(result?.teammate?.bib).toBe('202');
      expect(result?.teamWarning).toBeNull();
    });

    it('refuses to guess when three share a doubles club', async () => {
      // The old code picked a partner by bib parity. A roster that names three
      // people as one pair is a roster problem, and guessing put a stranger's
      // time on somebody's team.
      const service = new HjudgeJudgeService(
        fakeRaceResult([
          ...pair,
          row({ Bib: 203, Contest: 'Mixed Doubles', ContestID: 12, Club: 'T-1', wristbandid: 'W-203' }),
        ]),
      );
      const result = await service.resolveWristband(EVENT, 'W-201');
      expect(result?.teammate).toBeNull();
      expect(result?.teamWarning).toMatch(/More than two/);
    });

    it('says so when a doubles athlete has no partner on the roster', async () => {
      const service = new HjudgeJudgeService(fakeRaceResult([pair[0]]));
      const result = await service.resolveWristband(EVENT, 'W-201');
      expect(result?.teammate).toBeNull();
      expect(result?.teamWarning).toMatch(/teammate was not found/);
    });

    it('leaves a solo contest with no partner and no warning', async () => {
      const service = new HjudgeJudgeService(fakeRaceResult([row()]));
      const result = await service.resolveWristband(EVENT, 'WB-5502');
      expect(result?.teammate).toBeNull();
      expect(result?.teamWarning).toBeNull();
    });
  });
});
