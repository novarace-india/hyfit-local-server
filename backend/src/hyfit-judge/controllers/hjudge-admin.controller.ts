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
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { HjudgeAdminService } from '../services/hjudge-admin.service';
import {
  HjudgeParticipantSyncService,
  HjudgeSyncError,
} from '../services/hjudge-participant-sync.service';
import { HjudgeResultsService } from '../services/hjudge-results.service';
import { HjudgeCertificatesService } from '../services/hjudge-certificates.service';
import { HjudgeIngestService } from '../services/hjudge-ingest.service';
import { HjudgePushService } from '../services/hjudge-push.service';
import { hjudgeSyncConfig } from '../hjudge-sync.config';
import { HjudgeUserParam } from '../hjudge-user.decorator';
import type { HjudgeUser } from '../hjudge-auth.guard';
import { eventDateError } from '../hjudge-event-dates.util';
import {
  hashPin,
  HJUDGE_CHECKIN_STAGES,
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
    private readonly certificates: HjudgeCertificatesService,
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
    return this.adminService.getOverview(
      (await this.scopeTo(user, eventId)).eventId!,
    );
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
      eventEndDate?: string;
      deliveryMode?: string;
    },
    @HjudgeUserParam() user: HjudgeUser,
  ) {
    if (!body.name?.trim())
      throw new BadRequestException('Event name is required');
    const dateError = eventDateError(body.eventDate, body.eventEndDate);
    if (dateError) throw new BadRequestException(dateError);
    // Said out loud rather than coerced. 'offline' and 'online' are the whole
    // set, and anything else is a client that believes in a third mode — which
    // would otherwise be silently filed as online and discovered at a venue.
    if (
      body.deliveryMode !== undefined &&
      body.deliveryMode !== 'online' &&
      body.deliveryMode !== 'offline'
    ) {
      throw new BadRequestException(
        'Delivery mode must be either online or offline',
      );
    }
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
      // Day 1 and the last day. Sent from the console's schedule editor, which
      // is the only way an event created before it had a second day can get
      // one — the create form is a one-shot.
      eventDate?: string | null;
      eventEndDate?: string | null;
      resultsStatus?: string;
    },
    @HjudgeUserParam() user: HjudgeUser,
  ) {
    if (!body.id) throw new BadRequestException('Event ID is required');
    // Checked here rather than left to the CHECK constraint, so a swapped pair
    // comes back as a sentence. Only when the caller actually sent dates — the
    // other callers of this route (activate, status, rename) send none, and a
    // stored event with no Day 1 must stay editable.
    if (body.eventDate !== undefined || body.eventEndDate !== undefined) {
      const dateError = eventDateError(body.eventDate, body.eventEndDate);
      if (dateError) throw new BadRequestException(dateError);
    }
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

  /* GET /admin/events/delete-impact?eventId= — what a delete would remove.
     Read before the confirmation is shown, so the operator is told the actual
     numbers instead of a generic warning. Nothing is changed by this call. */
  @Get('events/delete-impact')
  @SetMetadata(HJUDGE_ROLES_KEY, ['super_admin'])
  async eventDeleteImpact(
    @HjudgeUserParam() user: HjudgeUser,
    @Query('eventId') eventId?: string,
  ) {
    return this.adminService.eventDeleteImpact(
      (await this.scopeTo(user, eventId)).eventId!,
    );
  }

  /* DELETE /admin/events?eventId=&confirm=<event name> — the event and
     everything that belongs to it.

     super_admin only, and unlike every other route here that is not just
     caution about scope: an event_admin is hired for one event, and this is the
     one action whose blast radius is the whole event including their own
     colleagues' accounts.

     `confirm` is the event's own name, typed. A delete that a single click
     could do is a delete that happens by accident on a list where two editions
     of the same race sit next to each other, and none of it is recoverable. */
  @Delete('events')
  @SetMetadata(HJUDGE_ROLES_KEY, ['super_admin'])
  async deleteEvent(
    @HjudgeUserParam() user: HjudgeUser,
    @Query('eventId') eventId?: string,
    @Query('confirm') confirm?: string,
  ) {
    const scoped = await this.scopeTo(user, eventId);
    return this.adminService.deleteEvent(scoped.eventId!, user, confirm ?? '');
  }

  @Get('users')
  @SetMetadata(HJUDGE_ROLES_KEY, ['super_admin', 'event_admin', 'readonly'])
  async listUsers(
    @HjudgeUserParam() user: HjudgeUser,
    @Query('eventId') eventId?: string,
  ) {
    return this.adminService.listUsers(
      (await this.scopeTo(user, eventId)).eventId!,
    );
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
      checkinStage?: string;
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
    if (
      body.checkinStage &&
      !HJUDGE_CHECKIN_STAGES.includes(String(body.checkinStage))
    ) {
      throw new BadRequestException('Invalid check-in stage');
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
        checkinStage?: string;
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
      checkinStage?: string | null;
      pin?: string;
      name?: string;
      staffId?: string;
      role?: string;
      eventId?: string;
    },
    @HjudgeUserParam() user: HjudgeUser,
  ) {
    if (!body.id) throw new BadRequestException('User ID is required');
    // Null clears the stage — a judge does not staff a counter. Anything else
    // must name one of the two stages that exist.
    if (
      body.checkinStage != null &&
      !HJUDGE_CHECKIN_STAGES.includes(String(body.checkinStage))
    ) {
      throw new BadRequestException('Invalid check-in stage');
    }
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
    return this.adminService.getConfig(
      (await this.scopeTo(user, eventId)).eventId!,
    );
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

  /* POST /admin/results/upload — multipart "file": the standings as JSON.
   *
   * The same act as `results/pull`, for an event whose feed cannot be fetched:
   * an offline venue, a RaceResult server that is down, an export that arrived
   * by email. `store` decides the destination exactly as it does there, and the
   * file goes through the same parser and the same mapping — see
   * HjudgeResultsService.pullUpload.
   *
   * MULTIPART, NOT A JSON BODY. A field of a few hundred athletes with fifteen
   * times each is megabytes, and the JSON body parser on this app is 100 KB
   * (which is why the offline push chunks itself at 80 KB). Widening that limit
   * for every route on the app to accommodate one upload is the wrong trade;
   * multipart is streamed by multer and bounded here alone.
   */
  @Post('results/upload')
  @SetMetadata(HJUDGE_ROLES_KEY, ['super_admin', 'event_admin'])
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: 32 * 1024 * 1024 },
    }),
  )
  async uploadResults(
    @Body() body: { store?: string; eventId?: string },
    @HjudgeUserParam() user: HjudgeUser,
    @Query('eventId') eventId?: string,
    @UploadedFile() file?: { buffer: Buffer; originalname: string },
  ) {
    const scoped = (await this.scopeTo(user, eventId ?? body?.eventId))
      .eventId!;
    const { data, label } = readJsonUpload(file);
    // A multipart field arrives as a string, so `store` is compared as one —
    // `Boolean("false")` is true, and getting that wrong here writes an
    // unfinished race into the tables the public page serves.
    return String(body?.store ?? '') === 'true'
      ? this.results.storeUpload(scoped, data, label)
      : this.results.pullUpload(scoped, data, label);
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

  /* POST /admin/athletes/upload — multipart "file": the start list as JSON.
   *
   * The participant endpoint's import, from a file. It REPLACES the roster the
   * same way that one does — a start list is the roster, whichever door it came
   * through — so a partial export drops everybody it leaves out. Same transport
   * reasoning as `results/upload` above. */
  @Post('athletes/upload')
  @SetMetadata(HJUDGE_ROLES_KEY, ['super_admin', 'event_admin'])
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: 32 * 1024 * 1024 },
    }),
  )
  async uploadAthletes(
    @Body() body: { eventId?: string },
    @HjudgeUserParam() user: HjudgeUser,
    @Query('eventId') eventId?: string,
    @UploadedFile() file?: { buffer: Buffer; originalname: string },
  ) {
    const scoped = (await this.scopeTo(user, eventId ?? body?.eventId))
      .eventId!;
    const { data, label } = readJsonUpload(file);
    return this.results.importAthletesUpload(scoped, data, label);
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

  /* ------------------------------------------------------ certificates
     The designs the public results page prints from. Event-scoped through
     `scopeTo` like everything else here, so a bound operator cannot edit
     another event's certificates by changing the query string.

     Note what is NOT here: any route that issues a certificate to a person.
     A certificate is rendered in the athlete's browser from the published
     template and the standings row already on the page, so there is nothing
     to hand out — see HjudgeCertificatesService. */

  @Get('certificates')
  @SetMetadata(HJUDGE_ROLES_KEY, ['super_admin', 'event_admin', 'readonly'])
  async listCertificateTemplates(
    @HjudgeUserParam() user: HjudgeUser,
    @Query('eventId') eventId?: string,
  ) {
    return this.certificates.list((await this.scopeTo(user, eventId)).eventId!);
  }

  @Get('certificates/:id')
  @SetMetadata(HJUDGE_ROLES_KEY, ['super_admin', 'event_admin', 'readonly'])
  async getCertificateTemplate(
    @Param('id') id: string,
    @HjudgeUserParam() user: HjudgeUser,
    @Query('eventId') eventId?: string,
  ) {
    return this.certificates.get(
      (await this.scopeTo(user, eventId)).eventId!,
      id,
    );
  }

  @Post('certificates')
  @SetMetadata(HJUDGE_ROLES_KEY, ['super_admin', 'event_admin'])
  async createCertificateTemplate(
    @Body()
    body: {
      contests?: string[];
      is_default?: boolean;
      name?: string;
      eventId?: string;
    },
    @HjudgeUserParam() user: HjudgeUser,
    @Query('eventId') eventId?: string,
  ) {
    const scoped = (await this.scopeTo(user, eventId ?? body?.eventId))
      .eventId!;
    return this.certificates.create(scoped, body ?? {});
  }

  @Put('certificates/:id')
  @SetMetadata(HJUDGE_ROLES_KEY, ['super_admin', 'event_admin'])
  async updateCertificateTemplate(
    @Param('id') id: string,
    @Body()
    body: {
      name?: string;
      /* Present = REPLACE this template's coverage with exactly these
         contests; absent = leave it alone. The console needs both, because
         publishing a design and re-scoping it are separate acts. */
      contests?: string[];
      is_default?: boolean;
      schema?: unknown;
      background_url?: string | null;
      is_published?: boolean;
      eventId?: string;
    },
    @HjudgeUserParam() user: HjudgeUser,
    @Query('eventId') eventId?: string,
  ) {
    const scoped = (await this.scopeTo(user, eventId ?? body?.eventId))
      .eventId!;
    return this.certificates.update(scoped, id, body ?? {});
  }

  @Delete('certificates/:id')
  @SetMetadata(HJUDGE_ROLES_KEY, ['super_admin', 'event_admin'])
  async deleteCertificateTemplate(
    @Param('id') id: string,
    @HjudgeUserParam() user: HjudgeUser,
    @Query('eventId') eventId?: string,
  ) {
    return this.certificates.remove(
      (await this.scopeTo(user, eventId)).eventId!,
      id,
    );
  }

  /* POST /admin/certificates/:id/background — the artwork, as multipart.

     Bounded here rather than globally for the same reason the results upload
     is: this is the only route on the app that takes an image, and 20 MB is a
     print-resolution A4 background with room to spare. */
  @Post('certificates/:id/background')
  @SetMetadata(HJUDGE_ROLES_KEY, ['super_admin', 'event_admin'])
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: 20 * 1024 * 1024 },
    }),
  )
  async uploadCertificateBackground(
    @Param('id') id: string,
    @Body() body: { eventId?: string },
    @HjudgeUserParam() user: HjudgeUser,
    @Query('eventId') eventId?: string,
    @UploadedFile()
    file?: { buffer: Buffer; originalname: string; mimetype?: string },
  ) {
    const scoped = (await this.scopeTo(user, eventId ?? body?.eventId))
      .eventId!;
    return this.certificates.uploadBackground(scoped, id, file);
  }

  @Get('participants/sync')
  @SetMetadata(HJUDGE_ROLES_KEY, ['super_admin', 'event_admin', 'readonly'])
  async listSyncRuns(
    @HjudgeUserParam() user: HjudgeUser,
    @Query('eventId') eventId?: string,
  ) {
    return this.adminService.listSyncRuns(
      (await this.scopeTo(user, eventId)).eventId!,
    );
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
      pushIntervals: local.pushIntervals,
      pullIntervals: local.pullIntervals,
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
    body: {
      label?: string;
      hours?: number;
      scopes?: string[];
      eventId?: string;
    },
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

  /* POST /admin/sync/pair { url, baseUrl? } — LOCAL.
   *
   * NO `eventId`, AND THAT IS THE CHANGE. Pairing is what CREATES the local
   * event: the pasted URL names a prod event, the handshake confirms which race
   * it is, and the row is written here under prod's own id. Scoping this to an
   * event the operator had already made by hand is what produced two events
   * that agreed only by luck. Handshakes before it stores anything, so a URL
   * for the wrong event fails on a read. */
  @Post('sync/pair')
  @SetMetadata(HJUDGE_ROLES_KEY, ['super_admin', 'event_admin'])
  async pairSyncTarget(@Body() body: { url?: string; baseUrl?: string }) {
    return this.push.pair(body ?? {});
  }

  /* DELETE /admin/sync/pair — LOCAL. Forgets prod; withdraws nothing already
     published, which is prod's own decision to make, and leaves the local event
     with everything the last pull gave it. */
  @Delete('sync/pair')
  @SetMetadata(HJUDGE_ROLES_KEY, ['super_admin', 'event_admin'])
  async unpairSyncTarget(
    @HjudgeUserParam() user: HjudgeUser,
    @Query('eventId') eventId?: string,
  ) {
    return this.push.unpair((await this.scopeTo(user, eventId)).eventId!);
  }

  /* POST /admin/sync/pull — LOCAL. The other button: prod's configuration for
     this event, applied here. Always applies, even when the digest matches,
     because the reason somebody presses it is that they doubt what this laptop
     is holding. */
  @Post('sync/pull')
  @SetMetadata(HJUDGE_ROLES_KEY, ['super_admin', 'event_admin'])
  async pullNow(
    @Body() body: { eventId?: string },
    @HjudgeUserParam() user: HjudgeUser,
    @Query('eventId') eventId?: string,
  ) {
    const scoped = await this.scopeTo(user, eventId ?? body?.eventId);
    return this.push.pullConfig(scoped.eventId!, 'manual', { force: true });
  }

  /* PUT /admin/sync/config { intervalMinutes?, pullIntervalMinutes?, enabled?,
     autoImportResults?, baseUrl?, pullUrl?, pushUrl? } — LOCAL.
     
     Two intervals, because the two directions answer to different things; 0
     means manual only on either. Takes effect on the scheduler's next tick,
     with no restart. */
  @Put('sync/config')
  @SetMetadata(HJUDGE_ROLES_KEY, ['super_admin', 'event_admin'])
  async configureSync(
    @Body()
    body: {
      intervalMinutes?: number;
      pullIntervalMinutes?: number;
      enabled?: boolean;
      autoImportResults?: boolean;
      baseUrl?: string;
      pullUrl?: string;
      pushUrl?: string;
      eventId?: string;
    },
    @HjudgeUserParam() user: HjudgeUser,
    @Query('eventId') eventId?: string,
  ) {
    const scoped = await this.scopeTo(user, eventId ?? body?.eventId);
    return this.push.configure(scoped.eventId!, body ?? {});
  }

  /* POST /admin/sync/check — LOCAL. Asks prod what the paired credential still
     opens, and sends nothing. The one call that is safe to make mid-race. */
  @Post('sync/check')
  @SetMetadata(HJUDGE_ROLES_KEY, ['super_admin', 'event_admin', 'readonly'])
  async checkSyncTarget(
    @HjudgeUserParam() user: HjudgeUser,
    @Query('eventId') eventId?: string,
  ) {
    return this.push.check((await this.scopeTo(user, eventId)).eventId!);
  }

  /* POST /admin/sync/push { kind: 'results' | 'results_final' } — LOCAL.
   *
   * The "push the results now" button. A manual results push always sends, even
   * when nothing has changed: the reason somebody presses it is that they
   * suspect prod is not holding what this database says, and a digest match is
   * exactly the answer they are doubting.
   *
   * There is no `athletes` kind since 093. Every result carries its own
   * athlete, so there is no roster to send separately and no order to send them
   * in. See HjudgePushService.pushResults. */
  @Post('sync/push')
  @SetMetadata(HJUDGE_ROLES_KEY, ['super_admin', 'event_admin'])
  async pushNow(
    @Body() body: { kind?: string; eventId?: string },
    @HjudgeUserParam() user: HjudgeUser,
    @Query('eventId') eventId?: string,
  ) {
    const scoped = (await this.scopeTo(user, eventId ?? body?.eventId))
      .eventId!;
    const kind = String(body?.kind ?? '').trim();
    if (kind === 'results')
      return this.push.pushResults(scoped, 'manual', { force: true });
    // The end-of-day act: the standings into prod's tables rather than its
    // cache, so they are still there tomorrow. See pushFinalResults.
    if (kind === 'results_final')
      return this.push.pushFinalResults(scoped, 'manual');
    throw new BadRequestException('Push results or results_final');
  }
}

/**
 * A picked file, turned into the payload the importers read.
 *
 * The parse happens HERE rather than in the service so a file that is not JSON
 * at all — a CSV renamed, half a download, a saved HTML error page — fails with
 * a sentence naming the file, before anything has been read as a start list.
 * The importers below it deal only in payloads that parsed.
 */
function readJsonUpload(file?: { buffer: Buffer; originalname: string }): {
  data: unknown;
  label: string;
} {
  if (!file?.buffer?.length)
    throw new BadRequestException('Attach a JSON file as "file"');

  const label = file.originalname?.trim() || 'the uploaded file';
  let text = file.buffer.toString('utf8');
  // A BOM is what an export saved out of Excel or Notepad on Windows carries,
  // and JSON.parse rejects it with "Unexpected token" pointing at column 1 —
  // which reads as a corrupt file rather than a harmless prefix.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  try {
    return { data: JSON.parse(text), label };
  } catch (err) {
    throw new BadRequestException(
      `${label} is not valid JSON: ${(err as Error).message}`,
    );
  }
}
