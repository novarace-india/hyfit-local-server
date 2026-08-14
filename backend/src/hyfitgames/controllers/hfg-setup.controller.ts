import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { Public } from '../../common/decorators/public.decorator';
import { HfgAdminGuard } from '../guards/hfg-admin.guard';
import { HfgAdminId } from '../decorators/hfg-user.decorator';
import { HfgSetupService } from '../services/hfg-setup.service';
import type { CategoryInput } from '../services/hfg-setup.service';
import { HfgRosterService } from '../services/hfg-roster.service';

/* Event setup, in the order an organiser works:
 *
 *   1. create the event      POST   events               (+ stations, categories)
 *      edit it later         PATCH  events/:id
 *                            PUT    events/:id/stations
 *                            POST   events/:id/categories …
 *   2. import its athletes   POST   events/:id/roster/import      (CSV/XLSX)
 *                            POST   events/:id/roster/raceresult  (participant API)
 *   3. set up operations     PUT    events/:id/integration
 *
 * Teams need no step of their own: an entry's club IS its team (migration 065),
 * so pairing is `PATCH registrations/:id` with a club.
 *
 * Shares the /api/hyfitgames/admin prefix with HfgAdminController; the two
 * controllers own disjoint paths.
 */
@Public()
@UseGuards(HfgAdminGuard)
@Controller('hyfitgames/admin')
export class HfgSetupController {
  constructor(
    private readonly setup: HfgSetupService,
    private readonly roster: HfgRosterService,
  ) {}

  // ---------------------------------------------------------------- events

  /* GET /api/hyfitgames/admin/events/:id/setup — the whole event in one call:
     the record, its course, its categories and its RaceResult endpoint. */
  @Get('events/:id/setup')
  getEvent(@Param('id') id: string) {
    return this.setup.getEvent(id);
  }

  /* POST /api/hyfitgames/admin/events */
  @Post('events')
  createEvent(@Body() body: Record<string, any>) {
    return this.setup.createEvent(body);
  }

  /* PATCH /api/hyfitgames/admin/events/:id */
  @Patch('events/:id')
  updateEvent(@Param('id') id: string, @Body() body: Record<string, unknown>) {
    return this.setup.updateEvent(id, body ?? {});
  }

  /* PUT /api/hyfitgames/admin/events/:id/stations
     { stations: [{ id?, name }] } — in course order */
  @Put('events/:id/stations')
  replaceStations(
    @Param('id') id: string,
    @Body() body: { stations?: { id?: string | null; name?: string }[] },
  ) {
    return this.setup.replaceStations(id, body?.stations ?? []);
  }

  // ------------------------------------------------------------ categories

  @Get('events/:id/categories')
  listCategories(@Param('id') id: string) {
    return this.setup.listCategories(id);
  }

  @Post('events/:id/categories')
  createCategory(@Param('id') id: string, @Body() body: CategoryInput) {
    return this.setup.createCategory(id, body ?? {});
  }

  @Patch('categories/:id')
  updateCategory(@Param('id') id: string, @Body() body: CategoryInput) {
    return this.setup.updateCategory(id, body ?? {});
  }

  @Delete('categories/:id')
  deleteCategory(@Param('id') id: string) {
    return this.setup.deleteCategory(id);
  }

  // ---------------------------------------------------------------- roster

  @Get('events/:id/roster')
  listRoster(@Param('id') id: string, @Query('search') search?: string) {
    return this.setup.listRoster(id, search);
  }

  /* POST /api/hyfitgames/admin/events/:id/roster/import
     multipart "file": csv/xlsx with at least Name and Bib columns */
  @Post('events/:id/roster/import')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: 10 * 1024 * 1024 },
    }),
  )
  importCsv(
    @Param('id') id: string,
    @HfgAdminId() adminId: string,
    @UploadedFile() file?: { buffer: Buffer; originalname: string },
  ) {
    if (!file)
      throw new BadRequestException('Attach a CSV or Excel file as "file"');
    return this.roster.importCsv(id, file.buffer, file.originalname, adminId);
  }

  /* POST /api/hyfitgames/admin/events/:id/roster/raceresult
     { url?, mapping? } — falls back to the endpoint stored for this event.

     Returns as soon as the payload has been fetched and accepted; the writing
     happens on the server afterwards. Follow it with GET .../roster/sync. The
     roster is minutes of work and this response is not the place to wait for
     it — a timeout on any proxy in between used to kill the socket and leave
     the operator with no idea whether the import had run. */
  @Post('events/:id/roster/raceresult')
  async importRaceResult(
    @Param('id') id: string,
    @HfgAdminId() adminId: string,
    @Body() body: { url?: string; mapping?: Record<string, unknown> },
  ) {
    const stored = await this.setup.getIntegration(id);
    const url = body?.url?.trim() || stored?.participant_api_url;
    if (!url)
      throw new BadRequestException(
        'No RaceResult participant endpoint is configured for this event — save one first',
      );
    const mapping = body?.mapping ?? stored?.participant_mapping ?? {};
    const started = await this.roster.startRaceResultImport(
      id,
      { url, mapping },
      adminId,
    );

    // An ad-hoc URL that just fetched a roster is stored, because the check-in
    // app resolves a bib against `participant_api_url` on the published config
    // and nothing else: an operator who pastes an endpoint here and never opens
    // Operations otherwise leaves a full roster the counter cannot search, and
    // every scan answers "BIB N was not found". Only after the pull has been
    // accepted — a URL that could not be fetched is not worth keeping — and
    // only when it differs, so a repeat import does not publish a new config
    // version per pull. The mapping travels with it when this call supplied
    // one, since the config's mapping is how the field apps read the same feed.
    if (url !== stored?.participant_api_url) {
      await this.setup.saveIntegration(
        id,
        {
          participant_api_url: url,
          participant_mapping: body?.mapping ?? stored?.participant_mapping,
        },
        adminId,
      );
    }

    return { ...started, state: 'running' as const };
  }

  /* GET /api/hyfitgames/admin/events/:id/roster/sync — progress of the pull
     that is running, or the verdict of the last one that finished. */
  @Get('events/:id/roster/sync')
  syncStatus(@Param('id') id: string) {
    return this.roster.getSyncStatus(id);
  }

  @Get('events/:id/imports')
  listImports(@Param('id') id: string) {
    return this.roster.listBatches(id);
  }

  /* POST /api/hyfitgames/admin/events/:id/entries — add one athlete by hand */
  @Post('events/:id/entries')
  addEntry(@Param('id') id: string, @Body() body: Record<string, string>) {
    return this.setup.addEntry(id, body ?? {});
  }

  /* POST /api/hyfitgames/admin/events/:id/registrations
     { entries: [{ mobile?, full_name?, bib, category?, wave?, timeslot?,
       contest_date? }] } — the paste
     box on the Athletes screen. Reports per row rather than failing the batch,
     because one bad line in forty should not lose the other thirty-nine. */
  @Post('events/:id/registrations')
  async register(
    @Param('id') id: string,
    @Body() body: { entries?: Record<string, string>[] },
  ) {
    const entries = body?.entries;
    if (!Array.isArray(entries) || !entries.length)
      throw new BadRequestException('entries[] required');

    const report = {
      created: 0,
      errors: [] as { index: number; reason: string }[],
    };
    for (const [i, e] of entries.entries()) {
      try {
        await this.setup.addEntry(id, e);
        report.created++;
      } catch (err) {
        report.errors.push({ index: i, reason: (err as Error).message });
      }
    }
    return report;
  }

  @Patch('entries/:id')
  updateEntry(@Param('id') id: string, @Body() body: Record<string, unknown>) {
    return this.setup.updateEntry(id, body ?? {});
  }

  @Delete('entries/:id')
  deleteEntry(@Param('id') id: string) {
    return this.setup.deleteEntry(id);
  }

  /* PATCH /api/hyfitgames/admin/registrations/:id { status } — kept for the
     console's roster status buttons, which address an entry by the id they
     have always called a registration id. */
  @Patch('registrations/:id')
  setRaceStatus(@Param('id') id: string, @Body() body: { status?: string }) {
    return this.setup.updateEntry(id, { race_status: body?.status });
  }

  // ----------------------------------------------------------------- teams
  //
  // No routes. A team is the entries sharing a club inside one group-format
  // category (migration 065), so it is built and disbanded through the club on
  // `PATCH registrations/:id` above. The GET/POST/DELETE events/:id/teams
  // endpoints are gone with the table they served.

  // ----------------------------------------------------------- integration

  @Get('events/:id/integration')
  getIntegration(@Param('id') id: string) {
    return this.setup.getIntegration(id);
  }

  @Put('events/:id/integration')
  saveIntegration(
    @Param('id') id: string,
    @HfgAdminId() adminId: string,
    @Body()
    body: { participant_api_url?: string; participant_mapping?: unknown },
  ) {
    return this.setup.saveIntegration(id, body ?? {}, adminId);
  }
}
