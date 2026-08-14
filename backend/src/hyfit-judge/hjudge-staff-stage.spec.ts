import { BadRequestException } from '@nestjs/common';
import { HjudgeAdminService } from './services/hjudge-admin.service';
import type { HjudgeUser } from './hjudge-auth.guard';

/* The check-in stage on a staff row — which shift a volunteer is rostered onto,
 * as the Team screen sets it.
 *
 * It is rostering only. Nothing at a counter reads it: the mapping table says
 * what the athlete already holds, and whichever hand-over is left is the one
 * that happens, whoever is standing there. What these tests hold to is that the
 * value the Team screen sends is the value that comes back to it — the whole of
 * the bug they were written for was a screen offering an assignment that three
 * layers below it quietly dropped, so a volunteer saved as Stage 2 read back as
 * having no stage at all.
 *
 * The other half is the hyfit_v2_users_stage_role constraint: a judge may not
 * hold a stage. Checking it here is what turns a data-entry slip into a
 * sentence the console can show, instead of a constraint violation surfacing as
 * a failed save with no reason attached.
 */

const EVENT = '11111111-1111-1111-1111-111111111111';

const actor: HjudgeUser = {
  id: 'admin-1',
  staffId: 'ADM-1',
  name: 'Admin',
  role: 'event_admin',
  eventId: EVENT,
  boundEventId: null,
  platformEventId: null,
  sessionId: 's1',
  deviceLabel: '',
  ipAddress: '',
};

type Call = { sql: string; params: unknown[] };

/** Captures what the service asks the database to do. */
function serviceWithCapture() {
  const calls: Call[] = [];
  const db = {
    q: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      return { rows: [{ id: 'new-user-id' }], rowCount: 1 };
    },
  };
  const service = new HjudgeAdminService(db as any, null as any);
  // The write, not the audit row that follows it.
  const write = (fragment: string) =>
    calls.find((call) => call.sql.includes(fragment))!;
  return { service, calls, write };
}

const hashPin = (pin: string) => `hashed:${pin}`;

describe('check-in stage on a staff row', () => {
  describe('creating', () => {
    it('writes the stage the Team screen chose', async () => {
      const { service, write } = serviceWithCapture();
      await service.createUser(
        {
          staffId: 'stf-102',
          pin: '5678',
          role: 'checkin',
          eventId: EVENT,
          checkinStage: 'STAGE_2_TRANSPONDER',
        },
        actor,
        hashPin,
      );
      const insert = write('INSERT INTO users');
      expect(insert.sql).toContain('checkin_stage');
      expect(insert.params).toContain('STAGE_2_TRANSPONDER');
    });

    it('puts a volunteer with no stage named on Stage 1', async () => {
      const { service, write } = serviceWithCapture();
      await service.createUser(
        { staffId: 'STF-103', pin: '4321', role: 'checkin', eventId: EVENT },
        actor,
        hashPin,
      );
      expect(write('INSERT INTO users').params).toContain('STAGE_1_WRISTBAND');
    });

    it('leaves a judge without one', async () => {
      const { service, write } = serviceWithCapture();
      await service.createUser(
        {
          staffId: 'STF-101',
          pin: '1234',
          role: 'judge',
          eventId: EVENT,
          stationNumber: 3,
        },
        actor,
        hashPin,
      );
      const insert = write('INSERT INTO users');
      expect(insert.params).not.toContain('STAGE_1_WRISTBAND');
      expect(insert.params).not.toContain('STAGE_2_TRANSPONDER');
    });

    it('refuses a stage on a judge rather than silently dropping it', async () => {
      const { service } = serviceWithCapture();
      await expect(
        service.createUser(
          {
            staffId: 'STF-104',
            pin: '1234',
            role: 'judge',
            eventId: EVENT,
            checkinStage: 'STAGE_1_WRISTBAND',
          },
          actor,
          hashPin,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('refuses a stage that is not one of the two', async () => {
      const { service } = serviceWithCapture();
      await expect(
        service.createUser(
          {
            staffId: 'STF-105',
            pin: '1234',
            role: 'checkin',
            eventId: EVENT,
            checkinStage: 'STAGE_3',
          },
          actor,
          hashPin,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('the CSV batch', () => {
    it('carries each row stage through, and defaults a blank cell to Stage 1', async () => {
      const { service, calls } = serviceWithCapture();
      const result = await service.createUsersBatch(
        [
          { staffId: 'STF-201', pin: '1111', role: 'checkin', checkinStage: 'STAGE_2_TRANSPONDER' },
          { staffId: 'STF-202', pin: '2222', role: 'checkin' },
        ],
        actor,
        hashPin,
      );
      expect(result.created).toBe(2);
      const inserts = calls.filter((call) => call.sql.includes('INSERT INTO users'));
      expect(inserts[0].params).toContain('STAGE_2_TRANSPONDER');
      expect(inserts[1].params).toContain('STAGE_1_WRISTBAND');
    });

    it('fails only the row whose stage is wrong', async () => {
      const { service } = serviceWithCapture();
      const result = await service.createUsersBatch(
        [
          { staffId: 'STF-203', pin: '3333', role: 'judge', checkinStage: 'STAGE_1_WRISTBAND' },
          { staffId: 'STF-204', pin: '4444', role: 'checkin' },
        ],
        actor,
        hashPin,
      );
      expect(result.created).toBe(1);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('STF-203');
    });
  });

  describe('editing', () => {
    it('saves a stage change', async () => {
      const { service, write } = serviceWithCapture();
      await service.updateUser(
        { id: 'u9', role: 'checkin', checkinStage: 'STAGE_2_TRANSPONDER' },
        actor,
        hashPin,
      );
      expect(write('UPDATE users').params).toContain('STAGE_2_TRANSPONDER');
    });

    it('leaves the stage alone when the edit does not mention it', async () => {
      // The Active/Disabled toggle posts nothing but the id and the flag, and
      // must not blank the shift on its way through.
      const { service, write } = serviceWithCapture();
      await service.updateUser({ id: 'u9', enabled: false }, actor, hashPin);
      const update = write('UPDATE users');
      expect(update.params[7]).toBeNull();
      expect(update.sql).toContain('ELSE checkin_stage END');
    });

    it('clears the stage when the person is moved off check-in', async () => {
      // Both halves of the row have to move together: role and stage are
      // checked against each other by hyfit_v2_users_stage_role, so a judge
      // left holding a stage is a save that fails at the database.
      const { service, write } = serviceWithCapture();
      await service.updateUser(
        { id: 'u9', role: 'judge', checkinStage: null },
        actor,
        hashPin,
      );
      expect(write('UPDATE users').params[7]).toBe('CLEAR');
    });

    it('clears it even when the caller forgot to', async () => {
      const { service, write } = serviceWithCapture();
      await service.updateUser({ id: 'u9', role: 'judge' }, actor, hashPin);
      expect(write('UPDATE users').params[7]).toBe('CLEAR');
    });

    it('refuses a stage that is not one of the two', async () => {
      const { service } = serviceWithCapture();
      await expect(
        service.updateUser(
          { id: 'u9', role: 'checkin', checkinStage: 'STAGE_9' },
          actor,
          hashPin,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('reading the roster back', () => {
    it('returns the stage to the Team screen', async () => {
      const { service, write } = serviceWithCapture();
      await service.listUsers(EVENT);
      expect(write('FROM users').sql).toContain('checkin_stage AS "checkinStage"');
    });
  });
});
