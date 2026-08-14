import { UnauthorizedException } from '@nestjs/common';
import { HjudgeAuthGuard, HjudgeCheckinAuthGuard } from './hjudge-auth.guard';
import { HjudgeAuthService } from './services/hjudge-auth.service';
import { hashPin, tokenHash } from './hjudge-session.util';
import { hjudgeConfig } from './hjudge.config';

/* Judging and check-in are two authentications, not one shared session behind
 * two doors.
 *
 * The separation has to hold in both directions and at both ends: a session
 * minted at a counter must be worthless on the judging routes, a judging
 * session must be worthless at a counter, and a judge's PIN must be refused at
 * the counter's door rather than accepted into a session that fails later. */

const JUDGE_TOKEN = 'judge-token';
const CHECKIN_TOKEN = 'checkin-token';

// Stands in for the sessions table: one row per audience, keyed the way the
// guard looks them up.
const rowsByAudience: Record<string, string> = {
  [`${tokenHash(JUDGE_TOKEN)}:judge`]: 'judge-session',
  [`${tokenHash(CHECKIN_TOKEN)}:checkin`]: 'checkin-session',
};

const db = {
  q: (sql: string, params: unknown[] = []) => {
    if (!sql.includes('FROM sessions')) return Promise.resolve({ rows: [] });
    const key = `${String(params[0])}:${String(params[1])}`;
    const id = rowsByAudience[key];
    return Promise.resolve({
      rows: id
        ? [
            {
              id,
              staffId: 'S1',
              name: 'Test',
              role: 'checkin',
              eventId: null,
              boundEventId: null,
              sessionId: id,
              deviceLabel: '',
              ipAddress: '',
            },
          ]
        : [],
    });
  },
} as any;

const contextWithCookie = (cookie: string) => {
  const request: any = { headers: { cookie } };
  return {
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({}) }),
  } as any;
};

const judgeCookie = (token: string) =>
  `${hjudgeConfig.sessionCookieName}=${token}`;
const checkinCookie = (token: string) =>
  `${hjudgeConfig.checkinCookieName}=${token}`;

describe('field session audiences', () => {
  it('lets each app in with its own session', async () => {
    await expect(
      new HjudgeAuthGuard(db).canActivate(
        contextWithCookie(judgeCookie(JUDGE_TOKEN)),
      ),
    ).resolves.toBe(true);
    await expect(
      new HjudgeCheckinAuthGuard(db).canActivate(
        contextWithCookie(checkinCookie(CHECKIN_TOKEN)),
      ),
    ).resolves.toBe(true);
  });

  it('refuses a counter session on the judging routes', async () => {
    await expect(
      new HjudgeAuthGuard(db).canActivate(
        contextWithCookie(judgeCookie(CHECKIN_TOKEN)),
      ),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('refuses a judging session at the counter', async () => {
    await expect(
      new HjudgeCheckinAuthGuard(db).canActivate(
        contextWithCookie(checkinCookie(JUDGE_TOKEN)),
      ),
    ).rejects.toThrow(UnauthorizedException);
  });

  // The judge cookie travelling on a check-in request is the ordinary case on a
  // shared tablet, not an attack — and it still must not open the counter.
  it('ignores the judge cookie entirely at the counter', async () => {
    await expect(
      new HjudgeCheckinAuthGuard(db).canActivate(
        contextWithCookie(
          `${judgeCookie(JUDGE_TOKEN)}; ${judgeCookie(CHECKIN_TOKEN)}`,
        ),
      ),
    ).rejects.toThrow(UnauthorizedException);
  });
});

describe('check-in login', () => {
  const userRow = (role: string) => ({
    rows: [
      {
        id: 'u1',
        staffId: 'S1',
        name: 'Test',
        pinHash: hashPin('1234'),
        role,
        eventId: null,
      },
    ],
  });

  const serviceFor = (role: string) => {
    const written: { sql: string; params: unknown[] }[] = [];
    const stub = {
      q: (sql: string, params: unknown[] = []) => {
        written.push({ sql, params });
        if (sql.includes('FROM users')) return Promise.resolve(userRow(role));
        return Promise.resolve({ rows: [{ expiresAt: 'later' }] });
      },
    } as any;
    return { service: new HjudgeAuthService(stub), written };
  };

  const response = () => ({ setHeader: jest.fn() }) as any;

  it('turns a judge away from the counter door', async () => {
    const { service } = serviceFor('judge');
    await expect(
      service.login('S1', '1234', '', '', response(), false, 'checkin'),
    ).rejects.toThrow(/not assigned to check-in/i);
  });

  it('stamps the audience on the session it opens', async () => {
    const { service, written } = serviceFor('checkin');
    const res = response();
    await service.login('S1', '1234', '', '', res, false, 'checkin');

    const insert = written.find((call) => call.sql.includes('INSERT INTO sessions'));
    expect(insert?.params).toContain('checkin');
    expect(String(res.setHeader.mock.calls[0][1])).toContain(
      hjudgeConfig.checkinCookieName,
    );
  });

  // The console signs in with a password and gets the field session its own
  // screens need. It must not also be signed in at a counter: a tablet that had
  // the admin console open would otherwise walk straight into check-in with
  // nobody having claimed the shift.
  it('never opens a counter from a console login', async () => {
    const written: { sql: string; params: unknown[] }[] = [];
    const stub = {
      q: (sql: string, params: unknown[] = []) => {
        written.push({ sql, params });
        if (sql.includes('FROM users'))
          return Promise.resolve({
            rows: [
              {
                id: 'u1',
                staffId: null,
                name: 'Console',
                role: 'event_admin',
                eventId: null,
              },
            ],
          });
        return Promise.resolve({ rows: [] });
      },
    } as any;
    const res = response();

    await new HjudgeAuthService(stub).openLinkedSession('u1', '', '', res);

    const inserts = written.filter((call) =>
      call.sql.includes('INSERT INTO sessions'),
    );
    expect(inserts).toHaveLength(1);
    expect(inserts[0].sql).toContain("'judge'");
    const cookies = String(res.setHeader.mock.calls.flat());
    expect(cookies).toContain(hjudgeConfig.sessionCookieName);
    expect(cookies).not.toContain(hjudgeConfig.checkinCookieName);
  });

  it('still opens a judge session for the judge app', async () => {
    const { service, written } = serviceFor('judge');
    const res = response();
    await service.login('S1', '1234', '', '', res, false, 'judge');

    const insert = written.find((call) => call.sql.includes('INSERT INTO sessions'));
    expect(insert?.params).toContain('judge');
    expect(String(res.setHeader.mock.calls[0][1])).toContain(
      hjudgeConfig.sessionCookieName,
    );
  });
});
