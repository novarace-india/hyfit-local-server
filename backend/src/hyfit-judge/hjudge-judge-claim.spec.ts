import { HjudgeJudgeService } from './services/hjudge-judge.service';
import { buildCheckinRoster } from './hjudge-checkin-rr.util';
import { isValidCognitiveSequence } from './hjudge-race-rules';

/**
 * Claiming and releasing an athlete.
 *
 * The hold is `judgedby` on the athlete's own RaceResult record — written on
 * claim, cleared on release. There is no lock table, so these tests pin the
 * three things that stand in for one: a claim reads the record FRESH, refuses
 * an athlete somebody else is running, and lets the judge who already holds one
 * walk back into it.
 */

const EVENT = '11111111-1111-1111-1111-111111111111';
const JUDGE = 'JDG-01';

const row = (over: Record<string, unknown> = {}) => ({
  Bib: 101,
  'First Name': 'Asha',
  Lastname: 'Menon',
  Contest: 'Female Open',
  ContestID: 6,
  Club: 'Fitness Club 19',
  Wave: '09:20',
  Transponder1: 'TR-8801',
  wristbandid: 'WB-5502',
  jugedby: '',
  ...over,
});

const mapping = { listPath: '', bib: 'bib', contestId: 'ContestID' };
const update = { wristband: 'wristbandID', transponder1: 'Transponder1' };

const assetKey = (v: unknown) =>
  String(v ?? '').trim().toLowerCase().replace(/^0+/, '') ||
  String(v ?? '').trim().toLowerCase();

/** A RaceResult stand-in whose rows change when written to. */
function fake(rows: Record<string, unknown>[], canWrite = true) {
  const state = rows.map((r) => ({ ...r }));
  const writes: { bib: string; field: string; value: string }[] = [];
  const freshCalls: boolean[] = [];

  const find = (code: string) => {
    const roster = buildCheckinRoster(state, mapping, update);
    const wanted = assetKey(code);
    const byWristband = roster.entries.find(
      (e) => assetKey(e.person.wristbandCode) === wanted,
    );
    const match =
      byWristband ??
      roster.entries.find((e) => assetKey(e.person.transponderCode) === wanted);
    return match ? { match, roster, byWristband } : null;
  };

  const service = {
    loadConfig: jest.fn(async () => ({ updateMapping: update }) as any),
    canWrite: jest.fn(() => canWrite),
    writeField: jest.fn(async (_c: any, bib: string, field: string, value: string) => {
      writes.push({ bib, field, value });
      const record = state.find((r) => String(r.Bib) === String(bib));
      if (record) record[field] = value;
    }),
    findByCode: jest.fn(async (_e: string, code: string, opts: any = {}) => {
      freshCalls.push(Boolean(opts.fresh));
      const found = find(code);
      if (!found) return null;
      return {
        equipment: {
          bib: found.match.person.bib,
          wristbandCode: found.match.person.wristbandCode,
          transponderCode: found.match.person.transponderCode,
          stage2Ready: false,
        },
        matchedAssetType: found.byWristband ? 'wristband' : 'transponder1',
        entry: found.match,
        roster: found.roster,
      };
    }),
    fetchAthlete: jest.fn(async (_c: any, _e: string, bib: string) => {
      const roster = buildCheckinRoster(state, mapping, update);
      return roster.entries.find((e) => e.person.bib === String(bib)) ?? null;
    }),
  };

  return { service, state, writes, freshCalls };
}

describe('claim', () => {
  it('writes the judge onto the athlete', async () => {
    const { service, state, writes } = fake([row()]);

    const result = await new HjudgeJudgeService(service as any).claim(
      EVENT,
      { code: 'WB-5502' },
      JUDGE,
    );

    expect(result?.claimedBy).toBe(JUDGE);
    expect(result?.resumed).toBe(false);
    expect(writes).toEqual([
      { bib: '101', field: 'jugedby', value: JUDGE },
    ]);
    expect(state[0].jugedby).toBe(JUDGE);
  });

  it('reads the record fresh, never from the cache', async () => {
    // The whole point is seeing a claim another judge made seconds ago, and the
    // roster cache is exactly long enough to miss one.
    const { service, freshCalls } = fake([row()]);
    await new HjudgeJudgeService(service as any).claim(EVENT, { code: 'WB-5502' }, JUDGE);
    expect(freshCalls[0]).toBe(true);
  });

  it('refuses an athlete another judge is running, and names them', async () => {
    const { service, writes } = fake([row({ jugedby: 'JDG-07' })]);

    await expect(
      new HjudgeJudgeService(service as any).claim(EVENT, { code: 'WB-5502' }, JUDGE),
    ).rejects.toThrow(/already being judged by JDG-07/);
    expect(writes).toHaveLength(0);
  });

  it('resumes an athlete this judge already holds', async () => {
    // A tablet that reloaded mid-race has to be able to walk back in.
    const { service, writes } = fake([row({ jugedby: JUDGE })]);

    const result = await new HjudgeJudgeService(service as any).claim(
      EVENT,
      { code: 'WB-5502' },
      JUDGE,
    );

    expect(result?.resumed).toBe(true);
    // Nothing rewritten: the hold is already theirs.
    expect(writes).toHaveLength(0);
  });

  it('matches the holder case-insensitively', async () => {
    const { service } = fake([row({ jugedby: 'jdg-01' })]);
    const result = await new HjudgeJudgeService(service as any).claim(
      EVENT,
      { code: 'WB-5502' },
      'JDG-01',
    );
    expect(result?.resumed).toBe(true);
  });

  it('claims by transponder as well as by wristband', async () => {
    const { service, state } = fake([row()]);
    await new HjudgeJudgeService(service as any).claim(EVENT, { code: 'TR-8801' }, JUDGE);
    expect(state[0].jugedby).toBe(JUDGE);
  });

  it('returns nothing for a code no athlete carries', async () => {
    const { service, writes } = fake([row()]);
    expect(
      await new HjudgeJudgeService(service as any).claim(EVENT, { code: 'WB-9999' }, JUDGE),
    ).toBeNull();
    expect(writes).toHaveLength(0);
  });

  // The roster path: the tablet already knows the athlete and sends the BIB it
  // is holding. The app calls this field `participantId` — with nothing stored,
  // the roster's id IS the bib.
  it('claims by BIB, as the roster does', async () => {
    const { service, state } = fake([row()]);
    const result = await new HjudgeJudgeService(service as any).claim(
      EVENT,
      { bib: '101' },
      JUDGE,
    );
    expect(result?.claimedBy).toBe(JUDGE);
    expect(state[0].jugedby).toBe(JUDGE);
  });

  it('refuses a claim naming no identifier at all', async () => {
    const { service } = fake([row()]);
    await expect(
      new HjudgeJudgeService(service as any).claim(EVENT, {}, JUDGE),
    ).rejects.toThrow(/Wristband ID, Transponder ID or BIB is required/);
  });

  it('refuses when the event cannot be written to at all', async () => {
    // Claiming without a write endpoint would hold an athlete only in the
    // tablet's head, and no other judge would ever see it.
    const { service, writes } = fake([row()], false);
    await expect(
      new HjudgeJudgeService(service as any).claim(EVENT, { code: 'WB-5502' }, JUDGE),
    ).rejects.toThrow(/no RaceResult update endpoint/i);
    expect(writes).toHaveLength(0);
  });
});

describe('an athlete who has already finished', () => {
  // `statusofathelet` is 1 once a race has been handed in, and it is the ONLY
  // thing on the record saying so. Without this gate a second judge picks up a
  // finished athlete, runs them again, and the re-submission overwrites the
  // real result field by field.
  const done = () => row({ statusofathelet: 1 });

  it('cannot be claimed again', async () => {
    const { service, writes } = fake([done()]);
    await expect(
      new HjudgeJudgeService(service as any).claim(
        EVENT,
        { code: 'WB-5502' },
        JUDGE,
      ),
    ).rejects.toThrow(/already completed their race/);
    expect(writes).toHaveLength(0);
  });

  it('cannot be claimed even by the judge who ran them', async () => {
    // Completed beats a hold. A finished athlete is nobody's to resume.
    const { service } = fake([row({ statusofathelet: 1, jugedby: JUDGE })]);
    await expect(
      new HjudgeJudgeService(service as any).claim(
        EVENT,
        { code: 'WB-5502' },
        JUDGE,
      ),
    ).rejects.toThrow(/already completed their race/);
  });

  it('is refused by BIB as well as by band', async () => {
    const { service } = fake([done()]);
    await expect(
      new HjudgeJudgeService(service as any).claim(EVENT, { bib: '101' }, JUDGE),
    ).rejects.toThrow(/already completed their race/);
  });

  it('reads as Completed when resolved', async () => {
    const { service } = fake([done()]);
    const result = await new HjudgeJudgeService(service as any).resolveWristband(
      EVENT,
      'WB-5502',
    );
    expect(result?.participant.status).toBe('Completed');
    expect(result?.participant.completed).toBe(true);
  });

  it('is still claimable while the flag is 0', async () => {
    const { service, state } = fake([row({ statusofathelet: 0 })]);
    const result = await new HjudgeJudgeService(service as any).claim(
      EVENT,
      { code: 'WB-5502' },
      JUDGE,
    );
    expect(result?.claimedBy).toBe(JUDGE);
    expect(state[0].jugedby).toBe(JUDGE);
  });
});

describe('who the hold belongs to', () => {
  // The scanner refuses an athlete reported as 'On course', so getting this
  // wrong is not cosmetic: a judge could not rescan an athlete they were
  // already running, and a doubles pairing could never complete once either
  // partner had been claimed. Whether a hold is 'Yours' or somebody else's
  // depends entirely on who is asking.
  it('is Yours to the judge holding it', async () => {
    const { service } = fake([row({ jugedby: JUDGE })]);
    const result = await new HjudgeJudgeService(service as any).resolveWristband(
      EVENT,
      'WB-5502',
      JUDGE,
    );
    expect(result?.participant.status).toBe('Yours');
  });

  it('is On course to anybody else', async () => {
    const { service } = fake([row({ jugedby: 'JDG-07' })]);
    const result = await new HjudgeJudgeService(service as any).resolveWristband(
      EVENT,
      'WB-5502',
      JUDGE,
    );
    expect(result?.participant.status).toBe('On course');
  });

  it('is Ready when nobody holds it', async () => {
    const { service } = fake([row()]);
    const result = await new HjudgeJudgeService(service as any).resolveWristband(
      EVENT,
      'WB-5502',
      JUDGE,
    );
    expect(result?.participant.status).toBe('Ready');
  });

  it('matches the holder case-insensitively', async () => {
    const { service } = fake([row({ jugedby: 'jdg-01' })]);
    const result = await new HjudgeJudgeService(service as any).resolveWristband(
      EVENT,
      'WB-5502',
      'JDG-01',
    );
    expect(result?.participant.status).toBe('Yours');
  });

  it('reports a claim back as the claiming judge’s own', async () => {
    // The claim re-resolves to build its response; that response must not tell
    // the judge who just claimed the athlete that somebody else has them.
    const { service } = fake([row()]);
    const result = await new HjudgeJudgeService(service as any).claim(
      EVENT,
      { code: 'WB-5502' },
      JUDGE,
    );
    expect(result?.participant.status).toBe('Yours');
  });

  it('still labels a finished athlete Completed, held or not', async () => {
    const { service } = fake([row({ statusofathelet: 1, jugedby: JUDGE })]);
    const result = await new HjudgeJudgeService(service as any).resolveWristband(
      EVENT,
      'WB-5502',
      JUDGE,
    );
    expect(result?.participant.status).toBe('Completed');
  });
});

describe('the cognitive sequence', () => {
  // Assigned here because the server owns what "legal" means: ten colours, all
  // four present, none three times in a row. A tablet generating its own would
  // be a second copy of that rule, and a race that fails validation AFTER being
  // run is one nobody can hand in.
  it('is assigned on claim', async () => {
    const { service } = fake([row()]);
    const result = await new HjudgeJudgeService(service as any).claim(
      EVENT,
      { code: 'WB-5502' },
      JUDGE,
    );
    expect(result?.cognitiveSequence).toHaveLength(10);
  });

  it('is one the submission will accept', async () => {
    // The exact check /judge/results runs. If these ever diverge, every race
    // becomes unsubmittable at the moment the judge tries to hand it in.
    const { service } = fake([row()]);
    for (let attempt = 0; attempt < 25; attempt += 1) {
      const result = await new HjudgeJudgeService(service as any).claim(
        EVENT,
        { code: 'WB-5502' },
        JUDGE,
      );
      expect(isValidCognitiveSequence(result?.cognitiveSequence)).toBe(true);
    }
  });
});

describe('claimPair', () => {
  const pair = [
    row({ Bib: 201, Contest: 'Mixed Doubles', ContestID: 12, Club: 'T-1', wristbandid: 'W-201' }),
    row({ Bib: 202, Contest: 'Mixed Doubles', ContestID: 12, Club: 'T-1', wristbandid: 'W-202' }),
  ];

  it('claims both athletes', async () => {
    const { service, state } = fake(pair);

    const result = await new HjudgeJudgeService(service as any).claimPair(
      EVENT,
      ['W-201', 'W-202'],
      JUDGE,
    );

    expect(result.participant.bib).toBe('201');
    expect(result.partner?.bib).toBe('202');
    expect(state[0].jugedby).toBe(JUDGE);
    expect(state[1].jugedby).toBe(JUDGE);
  });

  it('hands the first back when the partner is already held', async () => {
    // A pair half-claimed is worse than one not claimed at all: the other judge
    // would find their athlete taken by a race that never started.
    const { service, state } = fake([
      pair[0],
      { ...pair[1], jugedby: 'JDG-07' },
    ]);

    await expect(
      new HjudgeJudgeService(service as any).claimPair(
        EVENT,
        ['W-201', 'W-202'],
        JUDGE,
      ),
    ).rejects.toThrow(/already being judged by JDG-07/);

    expect(state[0].jugedby).toBe('');
  });

  it('refuses the same band scanned twice', async () => {
    const { service, state } = fake(pair);
    await expect(
      new HjudgeJudgeService(service as any).claimPair(
        EVENT,
        ['W-201', 'w-201'],
        JUDGE,
      ),
    ).rejects.toThrow(/two DIFFERENT partner wristbands/);
    expect(state[0].jugedby).toBe('');
  });

  it('refuses anything other than two bands', async () => {
    const { service } = fake(pair);
    await expect(
      new HjudgeJudgeService(service as any).claimPair(EVENT, ['W-201'], JUDGE),
    ).rejects.toThrow(/two different partner wristbands/i);
  });
});

describe('release', () => {
  it('clears the hold', async () => {
    const { service, state, writes } = fake([row({ jugedby: JUDGE })]);

    const result = await new HjudgeJudgeService(service as any).release(
      EVENT,
      '101',
      JUDGE,
    );

    expect(result.released).toBe(true);
    expect(writes).toEqual([{ bib: '101', field: 'jugedby', value: '' }]);
    expect(state[0].jugedby).toBe('');
  });

  it('refuses to release another judge’s athlete', async () => {
    // Releasing somebody else's athlete mid-race would put two tablets on one
    // person with neither of them knowing.
    const { service, writes } = fake([row({ jugedby: 'JDG-07' })]);

    await expect(
      new HjudgeJudgeService(service as any).release(EVENT, '101', JUDGE),
    ).rejects.toThrow(/held by JDG-07/);
    expect(writes).toHaveLength(0);
  });

  it('is harmless on an athlete nobody holds', async () => {
    const { service, state } = fake([row()]);
    await new HjudgeJudgeService(service as any).release(EVENT, '101', JUDGE);
    expect(state[0].jugedby).toBe('');
  });

  it('refuses a bib the feed does not have', async () => {
    const { service } = fake([row()]);
    await expect(
      new HjudgeJudgeService(service as any).release(EVENT, '999', JUDGE),
    ).rejects.toThrow(/was not found/);
  });
});
