import { HjudgeCheckinService } from './services/hjudge-checkin.service';
import { HjudgeRaceResultService } from './services/hjudge-raceresult.service';
import type { HjudgeUser } from './hjudge-auth.guard';

// The counter reads and writes RaceResult and keeps nothing of its own. These
// tests pin that down: what it asks the feed for, what it refuses, and what it
// writes back — with Postgres present only to hand over the endpoint config.

const PARTICIPANT_URL = 'https://rr.example.com/_1/api/READKEY';
const UPDATE_URL = 'https://rr.example.com/_1/api/WRITEKEY';
// The wristband -> BIB mapping table. Its own Custom API, fetched whole.
const MAP_URL = 'https://rr.example.com/_1/api/MAPKEY';
const EVENT = '11111111-1111-1111-1111-111111111111';

const configRow = (over: Record<string, unknown> = {}) => ({
  participantApiUrl: PARTICIPANT_URL,
  updateApiUrl: UPDATE_URL,
  mapLookupUrl: MAP_URL,
  participantMapping: { listPath: '', bib: 'bib', contestId: 'ContestID' },
  updateMapping: {},
  declarationText: 'I confirm my details are correct.',
  declarationVersion: 1,
  checkinWindowEnabled: false,
  checkinOpensBeforeMinutes: 240,
  checkinClosesAfterMinutes: null,
  timeZone: 'Asia/Kolkata',
  eventDate: '2026-08-15',
  eventStartsAt: null,
  ...over,
});

/** The shape _386828 actually returns, including the boolean stage flags. */
const athlete = (over: Record<string, unknown> = {}) => ({
  Bib: 11651,
  'First Name': 'Thomas',
  Lastname: 'Laurent',
  Contest: 'Male Pro',
  ContestID: 7,
  Gender: 'Male',
  Club: 'Fitness Club 19',
  DateOfBirth: '1998-07-28',
  Wave: 'Wave 01',
  TimeSlot: '6:00 PM - 8:00 PM',
  ContestDate: '2026-08-15',
  // Nothing issued. `Transponder1` is blank here on purpose: the organiser
  // pre-populates that column on the participant feed for the whole field
  // before the event opens, and a value somebody typed in a spreadsheet is not
  // a hand-over. The mapping table is what says what was actually issued, and
  // the test below pins exactly that distinction down.
  Transponder1: '',
  wristbandid: '',
  stage1checkin: false,
  stage1checkintime: '',
  stage2checkin: false,
  stage2checkintime: '',
  wristbandidAssignedBy: '',
  transponderAssignedBy: '',
  ...over,
});

const counter = (over: Partial<HjudgeUser> = {}): HjudgeUser =>
  ({
    id: 'u-1',
    staffId: 'VOL-01',
    name: 'Priya',
    role: 'checkin',
    eventId: EVENT,
    boundEventId: EVENT,
    sessionId: 's-1',
    deviceLabel: '',
    ipAddress: '',
    ...over,
  }) as HjudgeUser;

describe('HjudgeCheckinService', () => {
  let service: HjudgeCheckinService;
  let db: any;
  let cache: any;
  let fetchMock: jest.Mock;

  /**
   * A stand-in for the RaceResult server, with state.
   *
   * Modelled on how `_386828` actually behaves, because two of its habits are
   * what the code has to survive:
   *
   *  * a write answers `200` with a body of `0` whether or not the field
   *    exists — an unknown fieldname is accepted and silently discarded;
   *  * a read reflects writes immediately, and `?bib=` returns exactly the same
   *    row as the full list.
   *
   * So writes mutate the row only when the column is really there, which is the
   * one behaviour that makes a typo'd mapping detectable at all.
   */
  function feed(
    rows: Record<string, unknown>[],
    opts: { map?: Record<string, unknown>[] } = {},
  ) {
    const state = rows.map((row) => ({ ...row }));
    // The mapping table is its own endpoint. Left alone it is a view of the
    // same RaceResult rows — which is what makes a hand-over show up in it
    // immediately — but a test can serve it separately to pin down which of the
    // two endpoints an answer actually came from.
    const mapState = opts.map?.map((row) => ({ ...row })) ?? null;
    const norm = (k: string) => k.toLowerCase().replace(/[^a-z0-9]/g, '');

    fetchMock.mockImplementation(async (input: any) => {
      const url = new URL(String(input));
      const bib = url.searchParams.get('bib');

      if (String(input).startsWith(MAP_URL))
        return { ok: true, status: 200, json: async () => mapState ?? state } as any;

      if (String(input).startsWith(UPDATE_URL)) {
        const field = url.searchParams.get('fieldname') ?? '';
        const value = url.searchParams.get('value') ?? '';
        const row = state.find((r) => String(r.Bib) === String(bib));
        const key = row
          ? Object.keys(row).find((k) => norm(k) === norm(field))
          : undefined;
        // Present and writable: store it, coercing the boolean columns the way
        // RaceResult does. Absent: accepted, ignored, still a 200.
        if (row && key) {
          row[key] =
            typeof row[key] === 'boolean' ? !['', '0', 'false'].includes(value) : value;
        }
        return { ok: true, status: 200, text: async () => '0' } as any;
      }

      const body = bib
        ? state.filter((row) => String(row.Bib) === String(bib))
        : state;
      return { ok: true, status: 200, json: async () => body } as any;
    });
    return state;
  }

  const writes = () =>
    fetchMock.mock.calls
      .map(([input]) => String(input))
      .filter((url) => url.startsWith(UPDATE_URL))
      .map((url) => {
        const params = new URL(url).searchParams;
        return {
          bib: params.get('bib'),
          field: params.get('fieldname'),
          value: params.get('value'),
        };
      });

  beforeEach(() => {
    db = { q: jest.fn().mockResolvedValue({ rows: [configRow()] }) };
    cache = { get: jest.fn().mockResolvedValue(null), set: jest.fn().mockResolvedValue(undefined) };
    fetchMock = jest.fn();
    global.fetch = fetchMock as any;
    // The real RaceResult service, so these exercise the URLs actually built
    // and the payload actually parsed — only fetch and Postgres are faked.
    service = new HjudgeCheckinService(new HjudgeRaceResultService(db, cache));
  });

  describe('lookup', () => {
    it('asks the participant endpoint for the one bib', async () => {
      // Stage 1: the athlete gives a race number and it goes straight to the
      // feed as ?bib=. Verified against _386828 that the filtered row is
      // byte-identical to the same row in the full list — equipment, stage
      // flags, times and issuers all present.
      feed([athlete({ Bib: 10001 }), athlete({ wristbandid: 'A-11111' })]);
      const result = await service.getParticipant(EVENT, { bib: '11651' });

      expect(result?.participant.name).toBe('Thomas Laurent');
      expect(result?.participant.wristbandCode).toBe('A-11111');
      expect(
        fetchMock.mock.calls.some(
          ([input]) => new URL(String(input)).searchParams.get('bib') === '11651',
        ),
      ).toBe(true);
    });

    it('reads the athlete out of the start list', async () => {
      feed([athlete({ Bib: 10001 }), athlete()]);
      const result = await service.getParticipant(EVENT, { bib: '11651' });
      expect(result?.participant.bib).toBe('11651');
    });

    it('returns nothing for a bib RaceResult does not have', async () => {
      feed([athlete()]);
      expect(await service.getParticipant(EVENT, { bib: '99999' })).toBeNull();
    });

    // Stage 2 goes through the mapping table: the band gives a BIB, and the
    // BIB gives the athlete. `feed` serves the mapping URL from the same rows,
    // which is enough because the map only needs a bib and a wristband column.
    it('finds an athlete by the wristband issued at Stage 1', async () => {
      feed([athlete({ Bib: 10001 }), athlete({ wristbandid: 'A-11111' })]);
      const result = await service.getParticipant(EVENT, { wristband: 'a-11111' });
      expect(result?.participant.bib).toBe('11651');
    });

    it('returns nothing for a wristband the mapping table does not have', async () => {
      feed([athlete({ wristbandid: 'A-11111' })]);
      expect(
        await service.getParticipant(EVENT, { wristband: 'A-99999' }),
      ).toBeNull();
    });

    it('says nothing about stage flags in the lookup response', async () => {
      // The response used to carry `stages`, read off the feed's
      // stage1checkin/stage2checkin. Two fields answering "has this athlete
      // been through?", able to disagree — the equipment is the answer.
      feed([athlete({ stage1checkin: true, stage2checkin: true })]);
      const result = await service.getParticipant(EVENT, { bib: '11651' });
      expect(result).not.toHaveProperty('stages');
      expect(result?.assignment).toEqual({ bib: '11651', wristband: '', transponder: '' });
      expect(result?.nextStage).toBe('STAGE_1_WRISTBAND');
    });

    it('finds an athlete by the transponder they are carrying', async () => {
      // They were issued both and came back holding the chip, not the band.
      feed([athlete({ wristbandid: 'A-11111', Transponder1: 'Z-99999' })]);
      const result = await service.getParticipant(EVENT, { wristband: 'Z-99999' });
      expect(result?.participant.bib).toBe('11651');
      expect(result?.nextStage).toBeNull();
    });

    it('matches a scanned code case-insensitively in either column', async () => {
      feed([athlete({ wristbandid: 'A-11111', Transponder1: 'Z-99999' })]);
      expect(
        (await service.getParticipant(EVENT, { wristband: 'z-99999' }))?.participant.bib,
      ).toBe('11651');
    });

    it('prefers the wristband when one code is in both columns', async () => {
      feed([
        athlete({ Bib: 11651, wristbandid: 'DUP-1' }),
        athlete({ Bib: 11999, wristbandid: 'A-2', Transponder1: 'DUP-1' }),
      ]);
      expect(
        (await service.getParticipant(EVENT, { wristband: 'DUP-1' }))?.participant.bib,
      ).toBe('11651');
    });

    it('returns nothing for a code issued as neither', async () => {
      feed([athlete({ wristbandid: 'A-11111', Transponder1: 'Z-99999' })]);
      expect(
        await service.getParticipant(EVENT, { wristband: 'Q-00000' }),
      ).toBeNull();
    });

    it('refuses to work at all without a participant endpoint', async () => {
      db.q.mockResolvedValue({ rows: [configRow({ participantApiUrl: '' })] });
      await expect(service.getParticipant(EVENT, { bib: '11651' })).rejects.toThrow(
        /no RaceResult participant endpoint/i,
      );
    });

    it('surfaces the doubles partner sharing a club', async () => {
      feed([
        athlete({ Bib: 11651, Contest: 'Mixed Doubles', ContestID: 12, Club: 'T-1' }),
        athlete({ Bib: 11652, Contest: 'Mixed Doubles', ContestID: 12, Club: 'T-1' }),
      ]);
      const result = await service.getParticipant(EVENT, { bib: '11651' });
      expect(result?.teammates.map((m: any) => m.bib)).toEqual(['11652']);
    });
  });

  describe('completeStage', () => {
    const stage1 = {
      bib: '11651',
      stageType: 'STAGE_1_WRISTBAND' as const,
      assetCode: 'A-11111',
      governmentIdVerified: true,
      verbalDeclarationAccepted: true,
    };

    it('writes the asset and issuer, then the time, then the status', async () => {
      feed([athlete()]);
      const receipt = await service.completeStage(stage1, counter());

      expect(receipt.state).toBe('completed');
      expect(receipt.bib).toBe('11651');
      // Order matters: four GETs are not one transaction, and the status is
      // what means "this athlete has been through", so it goes last.
      expect(writes().map((w) => w.field)).toEqual([
        'wristbandID',
        'wristbandidAssignedBy',
        'stage1checkintime',
        'stage1checkin',
      ]);
      expect(writes()[0].value).toBe('A-11111');
      // The boolean field has to be set to something RaceResult stores as true.
      // 'COMPLETED' was written here while the field was assumed to be text.
      expect(writes()[3].value).toBe('1');
    });

    it('records which volunteer handed the equipment over', async () => {
      feed([athlete()]);
      await service.completeStage(stage1, counter());
      expect(
        writes().find((w) => w.field === 'wristbandidAssignedBy')?.value,
      ).toBe('VOL-01');
    });

    it('stamps the time on the event clock, not the server clock', async () => {
      feed([athlete()]);
      await service.completeStage(stage1, counter());
      expect(
        writes().find((w) => w.field === 'stage1checkintime')?.value,
      ).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    });

    it('ignores the stage flags — the equipment in the mapping table decides', async () => {
      // A flag set with no band against it describes a check-in that did not
      // happen. The athlete is still owed a wristband, and they get one.
      const rows = feed([athlete({ stage1checkin: true, wristbandid: '' })]);
      const receipt = await service.completeStage(stage1, counter());
      expect(receipt.state).toBe('completed');
      expect(rows[0].wristbandid).toBe('A-11111');
    });

    it('refuses when the mapping table already shows a band against the bib', async () => {
      // Due Stage 2, not Stage 1 — and the screen said Stage 1, so it is stale.
      feed([athlete({ wristbandid: 'A-99999' })]);
      await expect(service.completeStage(stage1, counter())).rejects.toThrow(
        /now due Stage 2, not Stage 1/,
      );
    });

    it('reads what an athlete holds from the mapping table, not the feed', async () => {
      // The exact trap the organiser's pre-populated column sets: the
      // participant feed says this athlete has transponder 7001651, and the
      // mapping table — which is where hand-overs are recorded — says they hold
      // nothing. They are due Stage 1, and a Stage 1 they get.
      feed([athlete({ Transponder1: '7001651' })], {
        map: [{ Bib: 11651, wristbandid: '', Transponder1: '' }],
      });
      const receipt = await service.completeStage(stage1, counter());
      expect(receipt.state).toBe('completed');
      expect(receipt.stageType).toBe('STAGE_1_WRISTBAND');
    });

    it('lets a false flag through — that is what not-checked-in looks like', async () => {
      feed([athlete({ stage1checkin: false, stage2checkin: false })]);
      const receipt = await service.completeStage(stage1, counter());
      expect(receipt.state).toBe('completed');
    });

    it('refuses an athlete who already holds both, and names what they hold', async () => {
      feed([athlete({ wristbandid: 'A-11111', Transponder1: 'T-1' })]);
      await expect(
        service.completeStage(
          { bib: '11651', assetCode: 'T-2' },
          counter(),
        ),
      ).rejects.toThrow(/already holds wristband A-11111 and transponder T-1/);
    });

    it('records nothing at all when the first write is rejected', async () => {
      feed([athlete()]);
      fetchMock.mockImplementation(async (input: any) => {
        const url = String(input);
        if (url.startsWith(UPDATE_URL))
          return { ok: false, status: 400, text: async () => 'bad field' } as any;
        return { ok: true, status: 200, json: async () => [athlete()] } as any;
      });

      await expect(service.completeStage(stage1, counter())).rejects.toThrow(
        /RaceResult did not accept/,
      );
      // One retry, then give up — and never move on to the status field.
      expect(writes().every((w) => w.field === 'wristbandID')).toBe(true);
    });

    // An event whose timing side reads a column of its own has to end up with
    // the transponder in both. `{"transponder1": "a", "transponder1": "b"}`
    // cannot say that — JSON keeps the last key and the first column then
    // silently stops being written — so the mapping takes a list.
    it('mirrors a transponder into every column the mapping lists', async () => {
      db.q.mockResolvedValue({
        rows: [
          configRow({
            updateMapping: { transponder1: ['Transponder1', 'chipused'] },
          }),
        ],
      });
      const rows = feed([
        athlete({ stage1checkin: true, wristbandid: 'A-11111', chipused: '' }),
      ]);

      await service.completeStage(
        { bib: '11651', stageType: 'STAGE_2_TRANSPONDER', assetCode: 'T-1' },
        counter(),
      );

      expect(rows[0].Transponder1).toBe('T-1');
      expect(rows[0].chipused).toBe('T-1');
      // Both mirrors before the step that vouches for them, and the status last
      // as always.
      expect(writes().map((w) => w.field)).toEqual([
        'Transponder1',
        'chipused',
        'transponderAssignedBy',
        'stage2checkintime',
        'stage2checkin',
      ]);
    });

    it('reads the mirrored stage back off the first column', async () => {
      db.q.mockResolvedValue({
        rows: [
          configRow({
            updateMapping: { transponder1: ['Transponder1', 'chipused'] },
          }),
        ],
      });
      feed([
        athlete({
          stage1checkin: true,
          stage2checkin: true,
          wristbandid: 'A-11111',
          Transponder1: 'T-1',
          chipused: 'T-1',
        }),
      ]);

      await expect(
        service.completeStage(
          { bib: '11651', stageType: 'STAGE_2_TRANSPONDER', assetCode: 'T-2' },
          counter(),
        ),
      ).rejects.toThrow(/already holds wristband A-11111 and transponder T-1/);
    });

    it('needs no stage assignment on the volunteer at all', async () => {
      // There is no such thing as a Stage 1 desk any more. The same counter,
      // the same volunteer, runs whichever stage the athlete is due.
      const rows = feed([athlete()]);
      await service.completeStage({ bib: '11651', assetCode: 'A-11111',
        governmentIdVerified: true, verbalDeclarationAccepted: true }, counter());
      expect(rows[0].wristbandid).toBe('A-11111');

      const receipt = await service.completeStage(
        { bib: '11651', assetCode: 'T-500' },
        counter(),
      );
      expect(receipt.stageType).toBe('STAGE_2_TRANSPONDER');
      expect(rows[0].Transponder1).toBe('T-500');
    });

    // The Help Desk override. An admin is never put on a desk by the Team
    // screen, so requiring a stage of them made the override unreachable: they
    // could sign in at a counter and then check nobody in.
    it('lets an admin work a counter', async () => {
      const rows = feed([athlete()]);
      await service.completeStage(stage1, counter({ role: 'event_admin' }));
      expect(rows[0].stage1checkin).toBe(true);
    });

    it('runs Stage 2 for an athlete already holding a band', async () => {
      const rows = feed([
        athlete({ stage1checkin: true, wristbandid: 'A-11111' }),
      ]);
      const receipt = await service.completeStage(
        { bib: '11651', assetCode: 'T-1' },
        counter(),
      );
      expect(receipt.stageType).toBe('STAGE_2_TRANSPONDER');
      expect(rows[0].stage2checkin).toBe(true);
    });

    it('treats a band alone as Stage 1 done, flag or no flag', async () => {
      // The inverse of the old rule. The band is the hand-over; the flag is a
      // stamp that may or may not have been written beside it.
      feed([athlete({ stage1checkin: false, wristbandid: 'A-99999' })]);
      const receipt = await service.completeStage(
        { bib: '11651', assetCode: 'T-1' },
        counter(),
      );
      expect(receipt.stageType).toBe('STAGE_2_TRANSPONDER');
    });

    it('refuses a screen asking for Stage 2 on an athlete holding nothing', async () => {
      feed([athlete()]);
      await expect(
        service.completeStage(
          { bib: '11651', stageType: 'STAGE_2_TRANSPONDER', assetCode: 'T-1' },
          counter(),
        ),
      ).rejects.toThrow(/now due Stage 1, not Stage 2/);
    });

    it('tells the receipt what the athlete is due next', async () => {
      feed([athlete()]);
      const first = await service.completeStage(stage1, counter());
      expect(first.nextStage).toBe('STAGE_2_TRANSPONDER');

      const second = await service.completeStage(
        { bib: '11651', assetCode: 'T-500' },
        counter(),
      );
      expect(second.nextStage).toBeNull();
    });

    // The Stage 2 path as the counter actually runs it: the app sends the band
    // it scanned, and the server does band -> bib -> athlete before writing.
    it('completes stage 2 against a scanned wristband', async () => {
      const rows = feed([
        athlete({ stage1checkin: true, wristbandid: 'A-11111' }),
      ]);

      const result = await service.completeStage(
        {
          wristband: 'a-11111',
          stageType: 'STAGE_2_TRANSPONDER',
          assetCode: 'T-500',
        },
        counter(),
      );

      expect(result.bib).toBe('11651');
      expect(rows[0].stage2checkin).toBe(true);
      expect(rows[0].Transponder1).toBe('T-500');
      // Written against the BIB the mapping table resolved, never the band.
      expect(writes().every((w) => w.bib === '11651')).toBe(true);
    });

    it('refuses a band that is against no bib', async () => {
      feed([athlete({ stage1checkin: true, wristbandid: 'A-11111' })]);
      await expect(
        service.completeStage(
          {
            wristband: 'A-99999',
            stageType: 'STAGE_2_TRANSPONDER',
            assetCode: 'T-500',
          },
          counter(),
        ),
      ).rejects.toThrow(/neither a wristband nor a transponder/i);
    });

    it('resolves a hand-over against a scanned transponder too', async () => {
      // Issued a band and a chip at another desk, then sent back holding only
      // the chip. It still identifies them.
      feed([athlete({ wristbandid: 'A-11111', Transponder1: 'Z-99999' })]);
      await expect(
        service.completeStage({ wristband: 'Z-99999', assetCode: 'T-2' }, counter()),
      ).rejects.toThrow(/already holds wristband A-11111 and transponder Z-99999/);
    });

    it('refuses a request naming neither a bib nor a band', async () => {
      feed([athlete()]);
      await expect(
        service.completeStage(
          { stageType: 'STAGE_1_WRISTBAND', assetCode: 'A-1',
            governmentIdVerified: true, verbalDeclarationAccepted: true },
          counter(),
        ),
      ).rejects.toThrow(/BIB or a wristband/i);
    });

    it('allows stage 2 once stage 1 is recorded', async () => {
      feed([athlete({ stage1checkin: true, wristbandid: 'A-11111' })]);
      const receipt = await service.completeStage(
        { bib: '11651', stageType: 'STAGE_2_TRANSPONDER', assetCode: 'T-500' },
        counter(),
      );
      expect(receipt.state).toBe('completed');
      expect(writes().map((w) => w.field)).toEqual([
        'Transponder1',
        'transponderAssignedBy',
        'stage2checkintime',
        'stage2checkin',
      ]);
    });

    it('requires the ID check and declaration at stage 1', async () => {
      feed([athlete()]);
      await expect(
        service.completeStage({ ...stage1, governmentIdVerified: false }, counter()),
      ).rejects.toThrow(/Government ID and participant declaration/);
      expect(writes()).toHaveLength(0);
    });

    it('enforces the check-in window on a volunteer but not on an admin', async () => {
      db.q.mockResolvedValue({
        rows: [
          configRow({
            checkinWindowEnabled: true,
            checkinOpensBeforeMinutes: 60,
            checkinClosesAfterMinutes: 0,
          }),
        ],
      });
      // A slot in 2026 that has long closed relative to any test run date is
      // avoided by using a far-future contest date instead: too early, not late.
      feed([athlete({ ContestDate: '2099-01-01', TimeSlot: '09:00' })]);

      await expect(service.completeStage(stage1, counter())).rejects.toThrow(
        /Too early/,
      );

      // The desk override: an event admin standing at a counter is the Help
      // Desk's answer to a wrong slot.
      const receipt = await service.completeStage(
        stage1,
        counter({ role: 'event_admin' }),
      );
      expect(receipt.state).toBe('completed');
    });

    it('refuses when the mapping names a field RaceResult does not have', async () => {
      // The failure this guards against: savevalue answers 200 for a fieldname
      // the event has never heard of, so one typo in the update mapping would
      // discard every check-in of the day while each counter reported success.
      db.q.mockResolvedValue({
        rows: [configRow({ updateMapping: { stage1checkin: 'stgae1checkin' } })],
      });
      feed([athlete()]);

      await expect(service.completeStage(stage1, counter())).rejects.toThrow(
        /still does not read as Stage 1 complete/,
      );
      // The write was attempted and accepted — that is exactly the problem.
      expect(writes().some((w) => w.field === 'stgae1checkin')).toBe(true);
    });

    // --------------------------------------------- a code already spoken for
    //
    // The check the counter did not have before. A wristband on two athletes
    // corrupts the timing data for both and does it silently: each row looks
    // perfectly valid on its own, and nothing downstream ever reports it.

    it('refuses a wristband already assigned to another bib, and names them', async () => {
      feed([
        athlete({ Bib: 11651, wristbandid: '' }),
        athlete({ Bib: 11999, wristbandid: 'A-11111' }),
      ]);
      await expect(service.completeStage(stage1, counter())).rejects.toThrow(
        /Wristband A-11111 is already assigned to BIB 11999 \(Thomas Laurent\)/,
      );
      expect(writes()).toHaveLength(0);
    });

    it('refuses a transponder already assigned to another bib', async () => {
      feed([
        athlete({ Bib: 11651, wristbandid: 'A-11111' }),
        athlete({ Bib: 11999, wristbandid: 'A-22222', Transponder1: 'T-500' }),
      ]);
      await expect(
        service.completeStage({ bib: '11651', assetCode: 'T-500' }, counter()),
      ).rejects.toThrow(/Transponder T-500 is already assigned to BIB 11999/);
      expect(writes()).toHaveLength(0);
    });

    it('matches a spoken-for code the way a scanner produces it', async () => {
      feed([
        athlete({ Bib: 11651, wristbandid: '' }),
        athlete({ Bib: 11999, wristbandid: 'A-11111' }),
      ]);
      await expect(
        service.completeStage({ ...stage1, assetCode: 'a-11111' }, counter()),
      ).rejects.toThrow(/already assigned to BIB 11999/);
    });

    it('does not confuse a wristband code with a transponder code', async () => {
      // Separate pools. An event may legitimately reuse the numbers, and a band
      // called T-500 must not block the transponder called T-500.
      const rows = feed([
        athlete({ Bib: 11651, wristbandid: 'A-11111' }),
        athlete({ Bib: 11999, wristbandid: 'T-500' }),
      ]);
      const receipt = await service.completeStage(
        { bib: '11651', assetCode: 'T-500' },
        counter(),
      );
      expect(receipt.stageType).toBe('STAGE_2_TRANSPONDER');
      expect(rows[0].Transponder1).toBe('T-500');
    });

    it('re-reads the mapping table fresh, never from the cache', async () => {
      // The window this closes: two desks a few seconds apart both reading a
      // 20-second-old copy and both deciding the same band was free.
      feed([
        athlete({ Bib: 11651, wristbandid: '' }),
        athlete({ Bib: 11999, wristbandid: 'A-11111' }),
      ]);
      cache.get.mockResolvedValue([{ Bib: 11999, wristbandid: '', Transponder1: '' }]);

      await expect(service.completeStage(stage1, counter())).rejects.toThrow(
        /already assigned to BIB 11999/,
      );
    });

    it('refuses to hand anything over without a mapping endpoint', async () => {
      db.q.mockResolvedValue({ rows: [configRow({ mapLookupUrl: '' })] });
      feed([athlete()]);
      await expect(service.completeStage(stage1, counter())).rejects.toThrow(
        /no RaceResult equipment mapping endpoint/i,
      );
      expect(writes()).toHaveLength(0);
    });

    it('refuses when the mapping table has no column for the asset', async () => {
      // "Nobody holds this" is not an answer the table gave — it is one nobody
      // was able to ask.
      feed([athlete({ wristbandid: 'A-11111' })], {
        map: [{ Bib: 11651, wristbandid: 'A-11111' }],
      });
      await expect(
        service.completeStage({ bib: '11651', assetCode: 'T-1' }, counter()),
      ).rejects.toThrow(/no transponder column/i);
      expect(writes()).toHaveLength(0);
    });

    it('refuses a bib RaceResult has never heard of', async () => {
      feed([athlete()]);
      await expect(
        service.completeStage({ ...stage1, bib: '99999' }, counter()),
      ).rejects.toThrow(/was not found/);
    });
  });

  describe('getContext', () => {
    it('reports the volunteer and the endpoints', async () => {
      feed([athlete()]);
      const context = await service.getContext(counter());

      expect(context.volunteer.staffId).toBe('VOL-01');
      expect(context.integration.configured).toBe(true);
      expect(context.integration.canWrite).toBe(true);
      expect(context.integration.mappingConfigured).toBe(true);
      expect(context.integration.mappingReadable).toBe(true);
      expect(context.integration.publishesWristband).toBe(true);
      expect(context.integration.publishesTransponder).toBe(true);
    });

    it('reports the shift the volunteer is rostered onto', async () => {
      feed([athlete()]);
      const context = await service.getContext(
        counter({ checkinStage: 'STAGE_2_TRANSPONDER' }),
      );
      expect(context.stage).toBe('STAGE_2_TRANSPONDER');
    });

    it('reports null for a volunteer nobody has rostered', async () => {
      feed([athlete()]);
      expect((await service.getContext(counter())).stage).toBeNull();
    });

    it('reports the shift without letting it limit the counter', async () => {
      // The whole point of the field: it is shown, not obeyed. A Stage 1
      // volunteer still completes the transponder hand-over for an athlete who
      // is due one, because what is left to give is the athlete's fact, not
      // the volunteer's. If this ever fails, the counter has started refusing
      // work on the strength of a rostering label.
      feed([athlete({ wristbandid: 'A-11111' })]);
      const stage1Volunteer = counter({ checkinStage: 'STAGE_1_WRISTBAND' });

      const lookup = await service.getParticipant(EVENT, { bib: '11651' });
      expect(lookup?.nextStage).toBe('STAGE_2_TRANSPONDER');

      await expect(
        service.completeStage(
          { bib: '11651', stageType: 'STAGE_2_TRANSPONDER', assetCode: 'T-900' },
          stage1Volunteer,
        ),
      ).resolves.toBeDefined();
    });

    it('says so when the mapping table is missing an asset column', async () => {
      // Every athlete would otherwise read as holding no transponder, and the
      // same chip could go to the whole field without one complaint.
      feed([athlete()], { map: [{ Bib: 11651, wristbandid: 'A-1' }] });
      const context = await service.getContext(counter());
      expect(context.integration.publishesWristband).toBe(true);
      expect(context.integration.publishesTransponder).toBe(false);
    });

    it('does not call an empty table misconfigured', async () => {
      // The morning of the event: nothing issued, so no rows and no columns to
      // read them from. That is not a broken endpoint.
      feed([athlete()], { map: [] });
      const context = await service.getContext(counter());
      expect(context.integration.mappingReadable).toBe(true);
      expect(context.integration.publishesTransponder).toBe(true);
    });

    it('says so when the event has no mapping endpoint', async () => {
      db.q.mockResolvedValue({ rows: [configRow({ mapLookupUrl: '' })] });
      feed([athlete()]);
      const context = await service.getContext(counter());
      expect(context.integration.mappingConfigured).toBe(false);
    });

    it('says so when the event has no write endpoint', async () => {
      db.q.mockResolvedValue({ rows: [configRow({ updateApiUrl: '' })] });
      feed([athlete()]);
      const context = await service.getContext(counter());
      expect(context.integration.canWrite).toBe(false);
    });
  });
});
