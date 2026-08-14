import { BadRequestException } from '@nestjs/common';
import { HjudgeAdminService } from './services/hjudge-admin.service';
import { HjudgeCheckinAuthGuard, type HjudgeUser } from './hjudge-auth.guard';
import { hjudgeConfig } from './hjudge.config';
import { tokenHash } from './hjudge-session.util';

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
  checkinStage: null,
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

  /* The other half of the trip: the Team screen writes the shift, and the
   * counter has to be able to see it. That is one hop — the guard reads it out
   * of `users` on every request, so a volunteer re-rostered mid-shift picks the
   * change up on their next call rather than at their next sign-in. */
  describe('carrying it to the counter', () => {
    const TOKEN = 'counter-token';

    function guardWithSession(row: Record<string, unknown> | null) {
      const seen: string[] = [];
      const db = {
        q: async (sql: string) => {
          seen.push(sql);
          return sql.includes('FROM sessions')
            ? { rows: row ? [row] : [], rowCount: row ? 1 : 0 }
            : { rows: [], rowCount: 0 };
        },
      };
      const request: any = {
        headers: { cookie: `${hjudgeConfig.checkinCookieName}=${TOKEN}` },
      };
      const context = {
        switchToHttp: () => ({
          getRequest: () => request,
          getResponse: () => ({}),
        }),
      } as any;
      return {
        guard: new HjudgeCheckinAuthGuard(db as any),
        context,
        request,
        sessionSql: () => seen.find((sql) => sql.includes('FROM sessions'))!,
      };
    }

    const sessionRow = (stage: string | null) => ({
      id: 'u-1',
      staffId: 'VOL-01',
      name: 'Priya',
      role: 'checkin',
      eventId: EVENT,
      boundEventId: EVENT,
      platformEventId: null,
      checkinStage: stage,
      sessionId: 's-1',
      deviceLabel: '',
      ipAddress: '',
    });

    it('asks the session query for the stage', async () => {
      const { guard, context, sessionSql } = guardWithSession(
        sessionRow('STAGE_2_TRANSPONDER'),
      );
      await guard.canActivate(context);
      expect(sessionSql()).toContain('u.checkin_stage AS "checkinStage"');
      // Read live from `users`, not stored on the session row — which is what
      // makes a re-rostering land without a re-login.
      expect(sessionSql()).toContain('JOIN users u ON u.id = s.user_id');
    });

    it('puts the stage on the request the counter routes read', async () => {
      const { guard, context, request } = guardWithSession(
        sessionRow('STAGE_2_TRANSPONDER'),
      );
      await guard.canActivate(context);
      expect(request.hjudgeUser.checkinStage).toBe('STAGE_2_TRANSPONDER');
    });

    it('carries a null through for anyone unrostered', async () => {
      const { guard, context, request } = guardWithSession(sessionRow(null));
      await guard.canActivate(context);
      expect(request.hjudgeUser.checkinStage).toBeNull();
    });

    it('looks the session up by the counter cookie and audience', async () => {
      const seen: unknown[][] = [];
      const db = {
        q: async (sql: string, params: unknown[] = []) => {
          if (sql.includes('FROM sessions')) seen.push(params);
          return { rows: [sessionRow('STAGE_1_WRISTBAND')], rowCount: 1 };
        },
      };
      const request: any = {
        headers: { cookie: `${hjudgeConfig.checkinCookieName}=${TOKEN}` },
      };
      await new HjudgeCheckinAuthGuard(db as any).canActivate({
        switchToHttp: () => ({
          getRequest: () => request,
          getResponse: () => ({}),
        }),
      } as any);
      expect(seen[0]).toEqual([tokenHash(TOKEN), 'checkin']);
    });
  });
});
