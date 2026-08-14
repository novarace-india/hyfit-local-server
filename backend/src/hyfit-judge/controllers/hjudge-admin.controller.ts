import {
  Controller,
  Get,
  Post,
  Patch,
  Put,
  Delete,
  Body,
  Query,
  Param,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  HttpException,
} from '@nestjs/common';
import { HjudgeAdminService } from '../services/hjudge-admin.service';
import {
  HjudgeParticipantSyncService,
  HjudgeSyncError,
} from '../services/hjudge-participant-sync.service';
import { HjudgeResultsService } from '../services/hjudge-results.service';
import { HjudgeIngestService } from '../services/hjudge-ingest.service';
import { HjudgePushService } from '../services/hjudge-push.service';
import { hjudgeSyncConfig } from '../hjudge-sync.config';
import { HjudgeUserParam } from '../hjudge-user.decorator';
import type { HjudgeUser } from '../hjudge-auth.guard';
import {
  hashPin,
  HJUDGE_PIN_PATTERN,
  HJUDGE_STAFF_ROLES,
} from '../hjudge-session.util';
import { UseGuards } from '@nestjs/common';
import { HjudgeAuthGuard } from '../hjudge-auth.guard';
import { HjudgeRolesGuard, HJUDGE_ROLES_KEY } from '../hjudge-roles.guard';
import { SetMetadata } from '@nestjs/common';

@Controller('hyfit-judge/admin')
@UseGuards(HjudgeAuthGuard, HjudgeRolesGuard)
export class HjudgeAdminController {
  constructor(
    private readonly adminService: HjudgeAdminService,
    private readonly syncService: HjudgeParticipantSyncService,
    private readonly results: HjudgeResultsService,
    // The two halves of offline-event sync. Both are injected on both
    // deployments; each refuses the acts that belong to the other role.
    private readonly ingest: HjudgeIngestService,
    private readonly push: HjudgePushService,
  ) {}

  // Team and Operations are screens of ONE event — /admin/events/:id/team and
  // /admin/events/:id/operations — so every route below acts on the event named
  // in that URL rather than on whichever event the session happens to resolve
  // to. Absent an explicit id the old behaviour stands, which is what keeps the
  // judge tablets and check-in app working unchanged.
  //
  // The narrowing is a permission boundary, not a convenience: field staff are
  // hired for one event (`boundEventId`), and without this check putting a
  // different event's id in the URL would read and write that event's roster,
  // counters and staff. Console admins are global and may move between events
  // freely, which is the whole point of an event-scoped URL for them.
  //
  // Returns a user object whose eventId IS the scoped one, so the services —
  // which all read user.eventId already — follow the URL with no further
  // plumbing, writes included.
  //
  // The id arrives as either the field event's or the platform listing's (see
  // resolveEventId), so it is resolved BEFORE the permission check: boundEventId
  // is a field id, and comparing it against a platform id would lock a bound
  // operator out of their own event.
  private async scopeTo(
    user: HjudgeUser,
    eventId?: string,
  ): Promise<HjudgeUser> {
    const requested = String(eventId ?? '').trim();
    if (!requested) return user;

    const resolved = await this.adminService.resolveEventId(requested);
    if (!resolved) throw new NotFoundException('Event not found');
    if (resolved === user.eventId) return user;
    if (user.boundEventId && resolved !== user.boundEventId) {
      throw new ForbiddenException('This account is assigned to another event');
    }
    return { ...user, eventId: resolved };
  }

  @Get('overview')
  @SetMetadata(HJUDGE_ROLES_KEY, ['super_admin', 'event_admin', 'readonly'])
  async getOverview(
    @HjudgeUserParam() user: HjudgeUser,
    @Query('eventId') eventId?: string,
  ) {
    return this.adminService.getOverview((await this.scopeTo(user, eventId)).eventId!);
  }

  @Get('events')
  @SetMetadata(HJUDGE_ROLES_KEY, ['super_admin', 'event_admin', 'readonly'])
  listEvents() {
    return this.adminService.listEvents();
  }

  // A field-only event. An event the public can enter is created by the
  // console's own form, POST /api/hyfitgames/admin/events, which writes the
  // listing and the operational row together.
  @Post('events')
  @SetMetadata(HJUDGE_ROLES_KEY, ['super_admin', 'event_admin'])
  async createEvent(
    @Body()
    body: {
      name?: string;
      venue?: string;
      startsAt?: string;
      endsAt?: string;
      timezone?: string;
      eventDate?: string;
    },
    @HjudgeUserParam() user: HjudgeUser,
  ) {
    if (!body.name?.trim())
      throw new BadRequestException('Event name is required');
    return this.adminService.createEvent(body as any, user);
  }

  @Patch('events')
  @SetMetadata(HJUDGE_ROLES_KEY, ['super_admin', 'event_admin'])
  async updateEvent(
    @Body()
    body: {
      id?: string;
      name?: string;
      venue?: string;
      status?: string;
      activate?: boolean;
      startsAt?: string;
      endsAt?: string;
      resultsStatus?: string;
    },
    @HjudgeUserParam() user: HjudgeUser,
  ) {
    if (!body.id) throw new BadRequestException('Event ID is required');
    // Resolved like every other event id on these screens, and for the reason
    // this one matters most: an UPDATE against an id this schema does not have
    // matches no rows and reports success, so activating an event by its
    // platform id would quietly do nothing at all.
    const scoped = await this.scopeTo(user, body.id);
    return this.adminService.updateEvent(
      { ...body, id: scoped.eventId! } as any,
      scoped,
    );
  }

  @Get('users')
  @SetMetadata(HJUDGE_ROLES_KEY, ['super_admin', 'event_admin', 'readonly'])
  async listUsers(
    @HjudgeUserParam() user: HjudgeUser,
    @Query('eventId') eventId?: string,
  ) {
    return this.adminService.listUsers((await this.scopeTo(user, eventId)).eventId!);
  }

  @Post('users')
  @SetMetadata(HJUDGE_ROLES_KEY, ['super_admin', 'event_admin'])
  async createUser(
    @Body()
    body: {
      staffId?: string;
      name?: string;
      pin?: string;
      role?: string;
      eventId?: string;
      stationNumber?: number;
      checkinStage?: string | null;
    },
    @HjudgeUserParam() user: HjudgeUser,
  ) {
    if (
      !body.staffId ||
      !HJUDGE_PIN_PATTERN.test(String(body.pin ?? '')) ||
      !HJUDGE_STAFF_ROLES.includes(String(body.role ?? ''))
    ) {
      throw new BadRequestException(
        'Staff ID, 4–8 digit PIN, and a role of judge or checkin are required',
      );
    }
    try {
      return await this.adminService.createUser(
        body as any,
        await this.scopeTo(user, body.eventId),
        hashPin,
      );
    } catch (error) {
      if (error.code === '23505')
        throw new ConflictException('Staff ID already exists');
      throw error;
    }
  }

  @Post('users/batch')
  @SetMetadata(HJUDGE_ROLES_KEY, ['super_admin', 'event_admin'])
  async createUsersBatch(
    @Body()
    body: {
      users: Array<{
        staffId?: string;
        name?: string;
        pin?: string;
        role?: string;
        stationNumber?: number;
        checkinStage?: string | null;
      }>;
      eventId?: string;
    },
    @HjudgeUserParam() user: HjudgeUser,
  ) {
    if (!Array.isArray(body.users) || body.users.length === 0) {
      throw new BadRequestException('At least one user is required');
    }
    return this.adminService.createUsersBatch(
      body.users,
      await this.scopeTo(user, body.eventId),
      hashPin,
    );
  }

  @Patch('users')
  @SetMetadata(HJUDGE_ROLES_KEY, ['super_admin', 'event_admin'])
  async updateUser(
    @Body()
    body: {
      id?: string;
      enabled?: boolean;
      stationNumber?: number;
      pin?: string;
      name?: string;
      staffId?: string;
      role?: string;
      eventId?: string;
      checkinStage?: string | null;
    },
    @HjudgeUserParam() user: HjudgeUser,
  ) {
    if (!body.id) throw new BadRequestException('User ID is required');
    // A PIN reset has to clear the same bar as creation — otherwise this route
    // is a back door to the un-loginable account the create route now blocks.
    // An absent or empty pin means "leave it alone", matching updateUser's
    // CASE WHEN ... IS NULL guard; only a supplied value is checked.
    if (body.pin && !HJUDGE_PIN_PATTERN.test(String(body.pin))) {
      throw new BadRequestException('A reset PIN must be 4–8 digits');
    }
    return this.adminService.updateUser(
      body as any,
      await this.scopeTo(user, body.eventId),
      hashPin,
    );
  }

  @Delete('users/:id')
  @SetMetadata(HJUDGE_ROLES_KEY, ['super_admin', 'event_admin'])
  async deleteUser(
    @Param('id') id: string,
    @Query('eventId') eventId: string | undefined,
    @HjudgeUserParam() user: HjudgeUser,
  ) {
    if (!id) throw new BadRequestException('User ID is required');
    return this.adminService.deleteUser(id, await this.scopeTo(user, eventId));
  }

  @Get('config')
  @SetMetadata(HJUDGE_ROLES_KEY, ['super_admin', 'event_admin', 'readonly'])
  async getConfig(
    @HjudgeUserParam() user: HjudgeUser,
    @Query('eventId') eventId?: string,
  ) {
    return this.adminService.getConfig((await this.scopeTo(user, eventId)).eventId!);
  }

  @Put('config')
  @SetMetadata(HJUDGE_ROLES_KEY, ['super_admin', 'event_admin'])
  async saveConfig(
    @Body() body: Record<string, any>,
    @HjudgeUserParam() user: HjudgeUser,
  ) {
    return this.adminService.saveConfig(
      body,
      await this.scopeTo(user, body.eventId as string | undefined),
    );
  }

  @Post('config')
  @SetMetadata(HJUDGE_ROLES_KEY, ['super_admin', 'event_admin'])
  async publishConfig(
    @Body() body: { id?: string; eventId?: string },
    @HjudgeUserParam() user: HjudgeUser,
  ) {
    if (!body.id || !body.eventId)
      throw new BadRequestException('Configuration and event are required');
    return this.adminService.publishConfig(
      body as any,
      await this.scopeTo(user, body.eventId),
    );
  }

  // ────────────────────────────────────────────────────── results and roster
  //
  // Both feeds are pulled from the endpoints published above, and the split
  // between them is the split in the tables: the participant endpoint fills
  // `athletes` (who is racing), the results endpoint fills `results` (what they
  // did) or the cache (what they are doing right now).
  //
  // Every route here is event-scoped through `scopeTo`, so a bound operator
  // cannot pull another event's standings by editing the URL.

  @Get('results')
  @SetMetadata(HJUDGE_ROLES_KEY, ['super_admin', 'event_admin', 'readonly'])
  async resultsState(
    @HjudgeUserParam() user: HjudgeUser,
    @Query('eventId') eventId?: string,
  ) {
    return this.results.state((await this.scopeTo(user, eventId)).eventId!);
  }

  /* GET /admin/results/preview?source=live|stored — the standings themselves,
     whatever the mode says. An operator has to be able to look before
     publishing. */
  @Get('results/preview')
  @SetMetadata(HJUDGE_ROLES_KEY, ['super_admin', 'event_admin', 'readonly'])
  async previewResults(
    @HjudgeUserParam() user: HjudgeUser,
    @Query('eventId') eventId?: string,
    @Query('source') source?: string,
  ) {
    const scoped = (await this.scopeTo(user, eventId)).eventId!;
    const payload = await this.results.preview(
      scoped,
      source === 'stored' ? 'stored' : 'live',
    );
    return { payload };
  }

  /* POST /admin/results/pull { url?, store? }
   *
   * `store` is the whole decision this endpoint exists to expose: false writes
   * one Valkey key and touches no table, true replaces the event's stored
   * standings. They are one route because they read the same feed with the same
   * mapping, and two would be two places for that parsing to drift. */
  @Post('results/pull')
  @SetMetadata(HJUDGE_ROLES_KEY, ['super_admin', 'event_admin'])
  async pullResults(
    @Body() body: { url?: string; store?: boolean; eventId?: string },
    @HjudgeUserParam() user: HjudgeUser,
    @Query('eventId') eventId?: string,
  ) {
    const scoped = (await this.scopeTo(user, eventId ?? body?.eventId))
      .eventId!;
    return body?.store
      ? this.results.store(scoped, body?.url)
      : this.results.pull(scoped, body?.url);
  }

  /* PUT /admin/results/mode { mode: 'off' | 'live' | 'stored' } */
  @Put('results/mode')
  @SetMetadata(HJUDGE_ROLES_KEY, ['super_admin', 'event_admin'])
  async setResultsMode(
    @Body() body: { mode?: string; eventId?: string },
    @HjudgeUserParam() user: HjudgeUser,
    @Query('eventId') eventId?: string,
  ) {
    const scoped = (await this.scopeTo(user, eventId ?? body?.eventId))
      .eventId!;
    return this.results.setMode(scoped, String(body?.mode ?? ''));
  }

  /* Throw the cached pull away. Deliberately NOT the same act as switching the
     mode off — "that pull was wrong" and "stop publishing" differ. */
  @Post('results/discard')
  @SetMetadata(HJUDGE_ROLES_KEY, ['super_admin', 'event_admin'])
  async discardResults(
    @Body() body: { eventId?: string },
    @HjudgeUserParam() user: HjudgeUser,
    @Query('eventId') eventId?: string,
  ) {
    const scoped = (await this.scopeTo(user, eventId ?? body?.eventId))
      .eventId!;
    return this.results.discard(scoped);
  }

  @Get('athletes')
  @SetMetadata(HJUDGE_ROLES_KEY, ['super_admin', 'event_admin', 'readonly'])
  async listAthletes(
    @HjudgeUserParam() user: HjudgeUser,
    @Query('eventId') eventId?: string,
    @Query('q') search?: string,
  ) {
    return this.results.listAthletes(
      (await this.scopeTo(user, eventId)).eventId!,
      search ?? '',
    );
  }

  /* The athlete import: the participant endpoint into `athletes`.
   *
   * Synchronous. A start list is a few thousand rows of upsert against one
   * table on one connection, which finishes inside a request — unlike the
   * console's old roster import, which wrote three tables in a schema this
   * deployment no longer has. */
  @Post('athletes/import')
  @SetMetadata(HJUDGE_ROLES_KEY, ['super_admin', 'event_admin'])
  async importAthletes(
    @Body() body: { eventId?: string },
    @HjudgeUserParam() user: HjudgeUser,
    @Query('eventId') eventId?: string,
  ) {
    const scoped = (await this.scopeTo(user, eventId ?? body?.eventId))
      .eventId!;
    return this.results.importAthletes(scoped);
  }

  /* DELETE /admin/athletes?eventId= — the whole roster for one event, and the
     results that hang off it.

     Destructive and deliberately unambiguous: it takes no filter, so there is
     no version of this call that deletes "some" athletes and no way to aim it
     at the wrong subset. The event in the URL is the only thing it acts on, and
     `scopeTo` has already checked the caller may act on that event. */
  @Delete('athletes')
  @SetMetadata(HJUDGE_ROLES_KEY, ['super_admin', 'event_admin'])
  async deleteAthletes(
    @HjudgeUserParam() user: HjudgeUser,
    @Query('eventId') eventId?: string,
  ) {
    return this.results.deleteAthletes(
      (await this.scopeTo(user, eventId)).eventId!,
    );
  }

  @Get('participants/sync')
  @SetMetadata(HJUDGE_ROLES_KEY, ['super_admin', 'event_admin', 'readonly'])
  async listSyncRuns(
    @HjudgeUserParam() user: HjudgeUser,
    @Query('eventId') eventId?: string,
  ) {
    return this.adminService.listSyncRuns((await this.scopeTo(user, eventId)).eventId!);
  }

  @Post('participants/sync')
  @SetMetadata(HJUDGE_ROLES_KEY, ['super_admin', 'event_admin'])
  async runParticipantSync(
    @HjudgeUserParam() user: HjudgeUser,
    @Query('eventId') eventId?: string,
  ) {
    try {
      return await this.syncService.runParticipantSync(
        await this.scopeTo(user, eventId),
      );
    } catch (error) {
      if (error instanceof HjudgeSyncError) {
        throw new HttpException(
          { error: error.message, message: error.message, runId: error.runId },
          error.status,
        );
      }
      throw error;
    }
  }


  // ──────────────────────────────────────────────────── offline event sync
  //
  // The console half of running an event on a local server and publishing it
  // from prod. Which of these routes does anything depends on what this server
  // IS (`HYFIT_NODE_ROLE`), and the screen behind them shows one half or the
  // other rather than both:
  //
  //   prod   mints and revokes the connection code a venue pastes in, and is
  //          where somebody decides an event is offline in the first place
  //   local  binds to that code, pushes the roster on request and the standings
  //          on a timer, and shows what has been sent
  //
  // The two services enforce their own role — a mint on a local node and a push
  // from a prod node are both refused there — so these routes stay thin, and a
  // console pointed at the wrong server says so instead of half-working.
  //
  // Everything here is event-scoped through `scopeTo`, like the rest of this
  // controller: field staff hired for one event cannot reach another's
  // credentials by editing the URL.

  /* GET /admin/sync — the whole Sync screen in one read.
   *
   * Both halves are returned whatever the role, because both tables exist on
   * both deployments (086 is applied to each) and the one that does not apply
   * is simply empty. The screen picks by `role`; a second round trip to
   * discover which half to ask for would only add a state where the page knows
   * its role and not yet its data. */
  @Get('sync')
  @SetMetadata(HJUDGE_ROLES_KEY, ['super_admin', 'event_admin', 'readonly'])
  async syncState(
    @HjudgeUserParam() user: HjudgeUser,
    @Query('eventId') eventId?: string,
  ) {
    const scoped = (await this.scopeTo(user, eventId)).eventId!;
    const [prod, local] = await Promise.all([
      this.ingest.credentialState(scoped),
      this.push.state(scoped),
    ]);
    return {
      role: hjudgeSyncConfig.nodeRole,
      roleWasUnrecognised: hjudgeSyncConfig.roleWasUnrecognised,
      event: local.event,
      counts: local.counts,
      intervals: local.intervals,
      credentials: prod.credentials,
      remoteCounts: prod.counts,
      target: local.target,
      runs: local.runs,
    };
  }

  /* PUT /admin/sync/delivery-mode { mode: 'online' | 'offline' }
   *
   * Set on BOTH deployments, on purpose. Prod's copy gates the ingest routes;
   * the local copy gates the push panel. An operator who flips only one gets a
   * clear refusal from the other rather than a connection that half exists. */
  @Put('sync/delivery-mode')
  @SetMetadata(HJUDGE_ROLES_KEY, ['super_admin', 'event_admin'])
  async setDeliveryMode(
    @Body() body: { mode?: string; eventId?: string },
    @HjudgeUserParam() user: HjudgeUser,
    @Query('eventId') eventId?: string,
  ) {
    const scoped = await this.scopeTo(user, eventId ?? body?.eventId);
    return this.ingest.setDeliveryMode(
      scoped.eventId!,
      String(body?.mode ?? ''),
      scoped,
    );
  }

  /* POST /admin/sync/credentials { label?, hours?, scopes? } — PROD.
   *
   * The response carries the secret. It is the only time it exists outside the
   * venue laptop it is about to be pasted into: only its hash is stored. */
  @Post('sync/credentials')
  @SetMetadata(HJUDGE_ROLES_KEY, ['super_admin', 'event_admin'])
  async mintSyncCredential(
    @Body()
    body: { label?: string; hours?: number; scopes?: string[]; eventId?: string },
    @HjudgeUserParam() user: HjudgeUser,
    @Query('eventId') eventId?: string,
  ) {
    this.ingest.assertProdRole();
    const scoped = await this.scopeTo(user, eventId ?? body?.eventId);
    return this.ingest.mintCredential(scoped.eventId!, body ?? {}, scoped);
  }

  /* DELETE /admin/sync/credentials/:id — PROD. Takes effect on the next push;
     there is no session to also tear down. */
  @Delete('sync/credentials/:id')
  @SetMetadata(HJUDGE_ROLES_KEY, ['super_admin', 'event_admin'])
  async revokeSyncCredential(
    @Param('id') id: string,
    @HjudgeUserParam() user: HjudgeUser,
    @Query('eventId') eventId?: string,
  ) {
    this.ingest.assertProdRole();
    const scoped = await this.scopeTo(user, eventId);
    return this.ingest.revokeCredential(scoped.eventId!, id, scoped);
  }

  /* POST /admin/sync/bind { code, baseUrl? } — LOCAL. Handshakes before it
     stores anything, so a code for the wrong event fails on a read. */
  @Post('sync/bind')
  @SetMetadata(HJUDGE_ROLES_KEY, ['super_admin', 'event_admin'])
  async bindSyncTarget(
    @Body() body: { code?: string; baseUrl?: string; eventId?: string },
    @HjudgeUserParam() user: HjudgeUser,
    @Query('eventId') eventId?: string,
  ) {
    const scoped = await this.scopeTo(user, eventId ?? body?.eventId);
    return this.push.bind(scoped.eventId!, body ?? {});
  }

  /* DELETE /admin/sync/bind — LOCAL. Forgets prod; withdraws nothing already
     published, which is prod's own decision to make. */
  @Delete('sync/bind')
  @SetMetadata(HJUDGE_ROLES_KEY, ['super_admin', 'event_admin'])
  async unbindSyncTarget(
    @HjudgeUserParam() user: HjudgeUser,
    @Query('eventId') eventId?: string,
  ) {
    return this.push.unbind((await this.scopeTo(user, eventId)).eventId!);
  }

  /* PUT /admin/sync/config { intervalMinutes?, enabled? } — LOCAL. The interval
     dropdown; 0 means manual only. Takes effect on the scheduler's next tick,
     with no restart. */
  @Put('sync/config')
  @SetMetadata(HJUDGE_ROLES_KEY, ['super_admin', 'event_admin'])
  async configureSync(
    @Body()
    body: {
      intervalMinutes?: number;
      enabled?: boolean;
      autoImportResults?: boolean;
      baseUrl?: string;
      eventId?: string;
    },
    @HjudgeUserParam() user: HjudgeUser,
    @Query('eventId') eventId?: string,
  ) {
    const scoped = await this.scopeTo(user, eventId ?? body?.eventId);
    return this.push.configure(scoped.eventId!, body ?? {});
  }

  /* POST /admin/sync/check — LOCAL. Asks prod what the bound credential still
     opens, and sends nothing. The one call that is safe to make mid-race. */
  @Post('sync/check')
  @SetMetadata(HJUDGE_ROLES_KEY, ['super_admin', 'event_admin', 'readonly'])
  async checkSyncTarget(
    @HjudgeUserParam() user: HjudgeUser,
    @Query('eventId') eventId?: string,
  ) {
    return this.push.check((await this.scopeTo(user, eventId)).eventId!);
  }

  /* POST /admin/sync/push { kind: 'athletes' | 'results' } — LOCAL.
   *
   * The roster button and the "push the results now" button. A manual results
   * push always sends, even when nothing has changed: the reason somebody
   * presses it is that they suspect prod is not holding what this database
   * says, and a digest match is exactly the answer they are doubting. */
  @Post('sync/push')
  @SetMetadata(HJUDGE_ROLES_KEY, ['super_admin', 'event_admin'])
  async pushNow(
    @Body() body: { kind?: string; eventId?: string },
    @HjudgeUserParam() user: HjudgeUser,
    @Query('eventId') eventId?: string,
  ) {
    const scoped = (await this.scopeTo(user, eventId ?? body?.eventId)).eventId!;
    const kind = String(body?.kind ?? '').trim();
    if (kind === 'athletes') return this.push.pushAthletes(scoped, 'manual');
    if (kind === 'results')
      return this.push.pushResults(scoped, 'manual', { force: true });
    // The end-of-day act: the standings into prod's tables rather than its
    // cache, so they are still there tomorrow. See pushFinalResults.
    if (kind === 'results_final') return this.push.pushFinalResults(scoped, 'manual');
    throw new BadRequestException(
      'Push athletes, results, or results_final',
    );
  }
}
