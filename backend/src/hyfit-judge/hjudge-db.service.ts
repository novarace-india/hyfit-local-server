import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import * as fs from 'fs';
import * as path from 'path';

@Injectable()
export class HjudgeDbService implements OnModuleInit, OnModuleDestroy {
  public pool!: Pool;
  private readonly logger = new Logger(HjudgeDbService.name);

  onModuleInit() {
    const useSsl = process.env.DB_SSL === 'true';
    this.pool = new Pool({
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '5432', 10),
      user: process.env.DB_USER || process.env.DB_USERNAME || 'postgres',
      password:
        process.env.DB_PASSWORD ??
        (() => {
          throw new Error('DB_PASSWORD environment variable is required');
        })(),
      database: process.env.DB_NAME || 'novarace',
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      // See HfgDbService: keeps idle pooled connections from being dropped by
      // anything between here and the database.
      keepAlive: true,
      ssl: useSsl
        ? {
            rejectUnauthorized: process.env.NODE_ENV === 'production',
            ca: fs
              .readFileSync(path.join(__dirname, '..', '..', 'db-ca.pem'))
              .toString(),
          }
        : false,
    });
    // Without this listener a dropped idle connection is an uncaught 'error'
    // event, which exits the process — see the long note in HfgDbService. The
    // field apps run on tablets over event wifi, so this pool meets dropped
    // connections more often than any other, not less.
    this.pool.on('error', (error) => {
      this.logger.error(
        `Idle Postgres connection dropped: ${error.message}. The pool replaces it; requests in flight are unaffected.`,
      );
    });
    this.pool.on('connect', (client) => {
      // `hyfit_judge` until that schema was dropped; the merge (043-061) moved
      // this module's tables into `hyfit`; 080 moved field ops again, into
      // `hyfit_v2`.
      //
      // `hyfit` is deliberately NOT on this path. Field ops reads and writes
      // nothing in it any more, and leaving it as a fallback would mean a table
      // this module no longer has quietly resolving to the old one instead of
      // failing — which is how half a cutover survives unnoticed until an event
      // day. A query that wants the athlete platform must say `hyfit.` out loud,
      // and right now none does.
      client.query('SET search_path TO hyfit_v2,public');
    });
  }

  async onModuleDestroy() {
    await this.pool?.end();
  }

  q<T extends QueryResultRow = any>(
    text: string,
    params?: unknown[],
  ): Promise<QueryResult<T>> {
    return this.pool.query<T>(text, params as any[]);
  }

  async q1<T extends QueryResultRow = any>(
    text: string,
    params?: unknown[],
  ): Promise<T | null> {
    const result = await this.pool.query<T>(text, params as any[]);
    return result.rows[0] ?? null;
  }

  async tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
}
