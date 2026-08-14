import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import type { PoolClient } from 'pg';
import { Public } from '../../common/decorators/public.decorator';
import { HfgDbService } from '../hfg-db.service';
import { HfgCacheService } from '../hfg-cache.service';
import { HfgResultsService } from '../services/hfg-results.service';
import { HfgTimingGuard } from '../guards/hfg-timing.guard';

interface TimingRecord {
  bib?: string;
  station_seq?: number | string;
  split_time?: string | number;
  split_raw?: string;
  chip_time?: string;
}
interface PushReport {
  recorded: number;
  processed: number;
  errors: { index: number; reason: string }[];
  warnings?: string[];
  batch_id?: string | null;
  compute?: unknown;
}

// RaceResult14 timing push endpoints. Secured by x-api-key (HfgTimingGuard),
// NOT JWT. Ported from routes/timing.js. Mounted under /api/hyfitgames/timing.
@Public()
@UseGuards(HfgTimingGuard)
@Controller('hyfitgames/timing')
export class HfgTimingController {
  constructor(
    private readonly db: HfgDbService,
    private readonly cache: HfgCacheService,
    private readonly results: HfgResultsService,
  ) {}

  /** Parse "HH:MM:SS.mmm" / "MM:SS.mmm" / raw ms into milliseconds. */
  private parseTime(raw: unknown): number | null {
    if (raw == null) return null;
    const s = String(raw).trim();
    if (/^\d+$/.test(s)) return parseInt(s, 10);
    const parts = s.split(':');
    if (parts.length === 3) {
      const [h, m, sec] = parts;
      return Math.round(
        parseInt(h) * 3600000 + parseInt(m) * 60000 + parseFloat(sec) * 1000,
      );
    }
    if (parts.length === 2) {
      const [m, sec] = parts;
      return Math.round(parseInt(m) * 60000 + parseFloat(sec) * 1000);
    }
    const f = parseFloat(s);
    if (!isNaN(f)) return Math.round(f * 1000);
    return null;
  }

  /* POST /api/hyfitgames/timing/push */
  @Post('push')
  async push(@Body() body: { event_id?: string; records?: TimingRecord[] }) {
    const { event_id, records } = body;

    if (!event_id) throw new BadRequestException('event_id is required');
    if (!Array.isArray(records) || records.length === 0)
      throw new BadRequestException(
        'records[] array is required (1-500 records per push)',
      );
    if (records.length > 500)
      throw new BadRequestException(
        'Maximum 500 records per push. Split into multiple requests.',
      );

    const { rows: ev } = await this.db.q(
      'SELECT id, status, results_status FROM events WHERE id = $1',
      [event_id],
    );
    if (!ev[0]) throw new NotFoundException('Event not found');
    if (ev[0].status === 'upcoming' || ev[0].status === 'draft')
      throw new BadRequestException(
        `Event is ${ev[0].status}. Set status to 'live' before pushing timing data.`,
      );

    const report: PushReport = {
      recorded: 0,
      processed: 0,
      errors: [],
      batch_id: null,
    };

    const { rows: batch } = await this.db.q(
      `INSERT INTO import_batches (event_id, source, origin_label, total_rows,
                                   athletes_created, athletes_updated,
                                   entries_created, entries_updated, error_rows, errors)
       VALUES ($1, 'raceresult_api', 'push', $2, 0, 0, 0, 0, 0, '[]'::jsonb)
       RETURNING id`,
      [event_id, records.length],
    );
    report.batch_id = batch[0].id;

    const toProcess: {
      entryId: string;
      stationId: string;
      splitMs: number;
      splitRaw: string;
    }[] = [];

    for (let i = 0; i < records.length; i++) {
      const rec = records[i];
      const bib = String(rec.bib || '').trim();
      const stationSeq = parseInt(String(rec.station_seq), 10);
      const splitMs = this.parseTime(rec.split_time);

      if (!bib) {
        report.errors.push({ index: i, reason: 'bib is required' });
        continue;
      }
      if (!stationSeq || stationSeq < 1 || stationSeq > 12) {
        report.errors.push({
          index: i,
          reason: `invalid station_seq: ${rec.station_seq}`,
        });
        continue;
      }
      if (!splitMs || splitMs <= 0) {
        report.errors.push({
          index: i,
          reason: `cannot parse split_time: "${rec.split_time}"`,
        });
        continue;
      }

      await this.db.q(
        `INSERT INTO timing_raw (event_id, bib, station_seq, split_ms, split_raw, chip_time, raw_payload)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          event_id,
          bib,
          stationSeq,
          splitMs,
          rec.split_raw || String(rec.split_time),
          rec.chip_time || null,
          JSON.stringify(rec),
        ],
      );
      report.recorded++;

      const { rows: match } = await this.db.q(
        `SELECT e.id AS entry_id, st.id AS station_id
           FROM category_entries e
           JOIN registrations r ON r.id = e.registration_id
           JOIN stations st ON st.event_id = r.event_id AND st.seq = $3
          WHERE r.event_id = $1 AND e.bib = $2`,
        [event_id, bib, stationSeq],
      );

      if (!match[0]) {
        report.errors.push({
          index: i,
          reason: `bib ${bib} not registered or station ${stationSeq} not found`,
        });
        continue;
      }

      toProcess.push({
        entryId: match[0].entry_id,
        stationId: match[0].station_id,
        splitMs,
        splitRaw: rec.split_raw || String(rec.split_time),
      });
    }

    if (toProcess.length > 0) {
      await this.db.tx(async (client) => {
        for (const p of toProcess) {
          await client.query(
            `INSERT INTO splits (entry_id, station_id, split_ms, split_raw, source)
             VALUES ($1, $2, $3, $4, 'raceresult')
             ON CONFLICT (entry_id, station_id)
             DO UPDATE SET split_ms = EXCLUDED.split_ms,
                           split_raw = EXCLUDED.split_raw,
                           source = 'raceresult',
                           recorded_at = now()`,
            [p.entryId, p.stationId, p.splitMs, p.splitRaw],
          );
        }
        await this.autoPromote(client, event_id);
        report.processed = toProcess.length;
      });
    }

    await this.db.q(
      `UPDATE import_batches
       SET entries_updated = $2, error_rows = $3, errors = $4
       WHERE id = $1`,
      [
        batch[0].id,
        report.processed,
        report.errors.length,
        JSON.stringify(report.errors),
      ],
    );

    await this.cache.invalidateEvent(event_id);
    return report;
  }

  /* POST /api/hyfitgames/timing/batch */
  @Post('batch')
  async batch(
    @Body() body: { event_id?: string; records?: TimingRecord[] },
    @Req() req: Request,
  ) {
    const { event_id, records } = body;
    if (!event_id) throw new BadRequestException('event_id is required');
    if (!Array.isArray(records) || records.length === 0)
      throw new BadRequestException('records[] required');

    const { rows: ev } = await this.db.q('SELECT * FROM events WHERE id = $1', [
      event_id,
    ]);
    if (!ev[0]) throw new NotFoundException('Event not found');

    const report = await this.pushTimingData(event_id, records, req.ip);

    let computeResult: unknown = null;
    try {
      computeResult = await this.results.computeResults(event_id);
    } catch (err) {
      report.warnings = report.warnings || [];
      report.warnings.push(
        `Result recomputation failed: ${(err as Error).message}`,
      );
    }

    report.compute = computeResult;
    await this.cache.invalidateEvent(event_id);
    return report;
  }

  /* GET /api/hyfitgames/timing/status/:eventId */
  @Get('status/:eventId')
  async status(@Param('eventId') eventId: string) {
    const { rows: ev } = await this.db.q(
      `SELECT id, name, status, results_status, event_date FROM events WHERE id = $1`,
      [eventId],
    );
    if (!ev[0]) throw new NotFoundException('Event not found');

    const { rows: stationCount } = await this.db.q(
      'SELECT count(*)::int AS n FROM stations WHERE event_id = $1',
      [eventId],
    );

    const { rows: regStats } = await this.db.q(
      `SELECT
        count(*)::int AS total_registrations,
        count(*) FILTER (WHERE ce.race_status = 'FIN')::int AS finishers,
        count(*) FILTER (WHERE ce.race_status = 'DNF')::int AS dnfs,
        count(*) FILTER (WHERE ce.race_status = 'DNS')::int AS dns
      FROM category_entries ce
      JOIN registrations r ON r.id = ce.registration_id
      WHERE ce.event_id = $1`,
      [eventId],
    );

    const { rows: splitStats } = await this.db.q(
      `SELECT
        count(*)::int AS total_splits,
        count(DISTINCT s.entry_id)::int AS athletes_with_splits
      FROM splits s
      WHERE s.entry_id IN (
        SELECT ce.id FROM category_entries ce
        JOIN registrations r ON r.id = ce.registration_id
        WHERE r.event_id = $1
      )`,
      [eventId],
    );

    const { rows: lastPush } = await this.db.q(
      `SELECT max(created_at) AS last_push_at
      FROM timing_raw WHERE event_id = $1`,
      [eventId],
    );

    const { rows: lastImport } = await this.db.q(
      `SELECT id, source, total_rows, entries_updated AS created_rows, error_rows, created_at
      FROM import_batches WHERE event_id = $1
      ORDER BY created_at DESC LIMIT 1`,
      [eventId],
    );

    const requiredStations = stationCount[0].n;
    const readyForResults = regStats[0].finishers;

    return {
      event: ev[0],
      stations_required: requiredStations,
      registrations: regStats[0],
      splits: splitStats[0],
      last_push: lastPush[0]?.last_push_at || null,
      last_import: lastImport[0] || null,
      ready_for_results: readyForResults,
      message:
        readyForResults > 0
          ? `${readyForResults} athlete(s) have all ${requiredStations} stations — ready to compute results`
          : 'No finishers yet — keep pushing splits',
    };
  }

  /* POST /api/hyfitgames/timing/recompute/:eventId */
  @Post('recompute/:eventId')
  async recompute(@Param('eventId') eventId: string) {
    const result = await this.results.computeResults(eventId);
    await this.cache.invalidateEvent(eventId);
    return { ok: true, ...result };
  }

  /* GET /api/hyfitgames/timing/events */
  @Get('events')
  async events() {
    const { rows } = await this.db.q(
      `SELECT e.id, e.name, e.edition, e.city, e.event_date, e.status, e.results_status,
             (SELECT count(*)::int FROM category_entries ce
               JOIN registrations r ON r.id = ce.registration_id
               WHERE r.event_id = e.id) AS participants,
             (SELECT count(*)::int FROM splits s
               WHERE s.entry_id IN (
                 SELECT ce2.id FROM category_entries ce2
                 JOIN registrations r2 ON r2.id = ce2.registration_id
                 WHERE r2.event_id = e.id
               )) AS splits_recorded
        FROM events e
        WHERE e.status IN ('live', 'completed')
        ORDER BY e.event_date DESC
        LIMIT 50`,
    );
    return rows;
  }

  // Auto-promote REG → FIN for athletes who have every station.
  private async autoPromote(client: PoolClient, eventId: string) {
    const { rows: sc } = await client.query(
      'SELECT count(*)::int AS n FROM stations WHERE event_id = $1',
      [eventId],
    );
    const need = sc[0].n;
    if (need > 0) {
      await client.query(
        `UPDATE category_entries SET race_status = 'FIN', updated_at = now()
          WHERE event_id = $1 AND race_status = 'REG'
            AND (SELECT count(DISTINCT s.station_id) FROM splits s
                 WHERE s.entry_id = category_entries.id) >= $2`,
        [eventId, need],
      );
    }
  }

  // Shared bulk-push logic used by /batch (mirrors routes/timing.js).
  private async pushTimingData(
    eventId: string,
    records: TimingRecord[],
    sourceIp?: string,
  ): Promise<PushReport> {
    const report: PushReport = {
      recorded: 0,
      processed: 0,
      errors: [],
      warnings: [],
    };

    const { rows: batch } = await this.db.q(
      `INSERT INTO import_batches (event_id, source, origin_label, total_rows,
                                   athletes_created, athletes_updated,
                                   entries_created, entries_updated, error_rows, errors)
       VALUES ($1, 'raceresult', 'batch', $2, 0, 0, 0, 0, 0, '[]'::jsonb)
       RETURNING id`,
      [eventId, records.length],
    );
    report.batch_id = batch[0].id;

    const toProcess: {
      entryId: string;
      stationId: string;
      splitMs: number;
      splitRaw: string;
    }[] = [];

    for (let i = 0; i < records.length; i++) {
      const rec = records[i];
      const bib = String(rec.bib || '').trim();
      const stationSeq = parseInt(String(rec.station_seq), 10);
      const splitMs = this.parseTime(rec.split_time);

      if (!bib) {
        report.errors.push({ index: i, reason: 'bib required' });
        continue;
      }
      if (!stationSeq || stationSeq < 1) {
        report.errors.push({
          index: i,
          reason: `bad station_seq: ${rec.station_seq}`,
        });
        continue;
      }
      if (!splitMs || splitMs <= 0) {
        report.errors.push({
          index: i,
          reason: `bad split_time: ${rec.split_time}`,
        });
        continue;
      }

      await this.db.q(
        `INSERT INTO timing_raw (event_id, bib, station_seq, split_ms, split_raw, source_ip, raw_payload)
         VALUES ($1, $2, $3, $4, $5, $6::inet, $7)`,
        [
          eventId,
          bib,
          stationSeq,
          splitMs,
          String(rec.split_time),
          sourceIp || null,
          JSON.stringify(rec),
        ],
      );
      report.recorded++;

      const { rows: match } = await this.db.q(
        `SELECT e.id AS entry_id, st.id AS station_id
           FROM category_entries e
           JOIN registrations r ON r.id = e.registration_id
           JOIN stations st ON st.event_id = r.event_id AND st.seq = $3
          WHERE r.event_id = $1 AND e.bib = $2`,
        [eventId, bib, stationSeq],
      );

      if (!match[0]) {
        report.errors.push({
          index: i,
          reason: `bib ${bib} not found at station ${stationSeq}`,
        });
        continue;
      }

      toProcess.push({
        entryId: match[0].entry_id,
        stationId: match[0].station_id,
        splitMs,
        splitRaw: String(rec.split_time),
      });
    }

    if (toProcess.length > 0) {
      await this.db.tx(async (client) => {
        for (const p of toProcess) {
          await client.query(
            `INSERT INTO splits (entry_id, station_id, split_ms, split_raw, source)
             VALUES ($1, $2, $3, $4, 'raceresult')
             ON CONFLICT (entry_id, station_id)
             DO UPDATE SET split_ms = EXCLUDED.split_ms,
                           split_raw = EXCLUDED.split_raw,
                           source = 'raceresult',
                           recorded_at = now()`,
            [p.entryId, p.stationId, p.splitMs, p.splitRaw],
          );
        }
        await this.autoPromote(client, eventId);
        report.processed = toProcess.length;
      });
    }

    await this.db.q(
      `UPDATE import_batches SET entries_updated=$2, error_rows=$3, errors=$4 WHERE id=$1`,
      [
        batch[0].id,
        report.processed,
        report.errors.length,
        JSON.stringify(report.errors),
      ],
    );

    return report;
  }
}
