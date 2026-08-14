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

}
