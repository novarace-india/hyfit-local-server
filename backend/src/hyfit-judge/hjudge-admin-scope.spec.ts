import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { HjudgeAdminController } from './controllers/hjudge-admin.controller';
import type { HjudgeUser } from './hjudge-auth.guard';

/* The event-scoping boundary behind /admin/events/:id/team and
 * /admin/events/:id/operations.
 *
 * Naming the event in the URL is what makes these screens children of an event;
 * this is the check that stops it from also being a way to read and write an
 * event you were not hired for.
 *
 * Since 080 the id in that URL can be EITHER the field event's or the platform
 * listing's, because the same URL serves screens on both sides of the split and
 * the link that got you there decides which id it knew. Both are accepted and
 * resolved here — which is why the order matters: resolve first, then check the
 * permission, or a bound operator arriving with their own event's platform id
 * would be refused their own event.
 */

const FIELD_A = '11111111-1111-1111-1111-111111111111';
const FIELD_B = '22222222-2222-2222-2222-222222222222';
/** The athlete-platform listing that FIELD_A is run as. */
const PLATFORM_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

const user = (over: Partial<HjudgeUser>): HjudgeUser => ({
  // Stated rather than left to the spread: `platformEventId` is non-optional on
  // HjudgeUser, and a Partial<> override widens it to `| undefined` — so the
  // default has to be here, below the spread's reach, not implied by it.
  platformEventId: null,
  id: 'u1',
  staffId: 'S1',
  name: 'Test',
  role: 'event_admin',
  eventId: FIELD_A,
  boundEventId: null,
  checkinStage: null,
  sessionId: 's1',
  deviceLabel: '',
  ipAddress: '',
  ...over,
});

/** Stands in for the two rows the resolver reads. */
const adminService = {
  resolveEventId: async (id: string) =>
    id === PLATFORM_A ? FIELD_A : [FIELD_A, FIELD_B].includes(id) ? id : null,
};

// scopeTo is private by design — nothing outside the controller should be able
// to widen a session's event — so the test reaches it the same way the routes do.
const controller = new HjudgeAdminController(
  adminService as any,
  null as any,
  null as any,
  null as any,
  null as any,
  null as any,
);
const scopeTo = (u: HjudgeUser, eventId?: string): Promise<HjudgeUser> =>
  (controller as any).scopeTo(u, eventId);

describe('HYFIT admin event scoping', () => {
  it('leaves the session event alone when the URL names no event', async () => {
    const consoleAdmin = user({ boundEventId: null });
    expect((await scopeTo(consoleAdmin, undefined)).eventId).toBe(FIELD_A);
    expect((await scopeTo(consoleAdmin, '')).eventId).toBe(FIELD_A);
    expect((await scopeTo(consoleAdmin, '   ')).eventId).toBe(FIELD_A);
  });

  it('lets a console admin act on any event named in the URL', async () => {
    expect((await scopeTo(user({ boundEventId: null }), FIELD_B)).eventId).toBe(
      FIELD_B,
    );
  });

  it('refuses field staff another event, however the id arrives', async () => {
    const judge = user({ role: 'judge', boundEventId: FIELD_A });
    await expect(scopeTo(judge, FIELD_B)).rejects.toThrow(ForbiddenException);
  });

  it('lets field staff name their own event explicitly', async () => {
    const judge = user({ role: 'judge', boundEventId: FIELD_A });
    expect((await scopeTo(judge, FIELD_A)).eventId).toBe(FIELD_A);
  });

  it('does not mutate the session user it was given', async () => {
    const consoleAdmin = user({ boundEventId: null });
    await scopeTo(consoleAdmin, FIELD_B);
    expect(consoleAdmin.eventId).toBe(FIELD_A);
  });

  // The 080 split. An event reached from the athlete console carries its
  // listing's id; the same screens must land on the field event it is run as.
  it('accepts the platform listing id for the same event', async () => {
    expect((await scopeTo(user({ boundEventId: null }), PLATFORM_A)).eventId).toBe(
      FIELD_A,
    );
  });

  it('does not refuse bound staff arriving with their own platform id', async () => {
    // boundEventId is a FIELD id. Comparing it against the platform id before
    // resolving would lock this operator out of the event they were hired for.
    const judge = user({ role: 'judge', boundEventId: FIELD_A });
    expect((await scopeTo(judge, PLATFORM_A)).eventId).toBe(FIELD_A);
  });

  it('reports an unknown event rather than silently using the session one', async () => {
    // Falling back to user.eventId here is how one event's configuration gets
    // written onto another.
    await expect(
      scopeTo(user({ boundEventId: null }), '99999999-9999-9999-9999-999999999999'),
    ).rejects.toThrow(NotFoundException);
  });

  it('reports an id that is not a uuid at all', async () => {
    await expect(
      scopeTo(user({ boundEventId: null }), 'not-an-id'),
    ).rejects.toThrow(NotFoundException);
  });

  // A route, not just the helper: the staff roster is another event's people,
  // so it goes through the same gate as everything else on these screens.
  it('lists staff only for the event the session may act on', async () => {
    const listed: string[] = [];
    const admin = new HjudgeAdminController(
      {
        ...adminService,
        listUsers: (eventId: string) => {
          listed.push(eventId);
          return Promise.resolve({ users: [] });
        },
      } as any,
      null as any,
      null as any,
      null as any,
      null as any,
      null as any,
    );

    await admin.listUsers(user({ boundEventId: null }), FIELD_B);
    expect(listed).toEqual([FIELD_B]);

    await expect(
      admin.listUsers(user({ role: 'judge', boundEventId: FIELD_A }), FIELD_B),
    ).rejects.toThrow(ForbiddenException);
    expect(listed).toEqual([FIELD_B]);
  });
});
