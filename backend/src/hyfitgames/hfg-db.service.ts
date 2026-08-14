import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import * as fs from 'fs';
import * as path from 'path';

// Dedicated Postgres pool for the HYFIT Games module. It connects to the same
// Novarace database as the rest of the app, but every connection is pinned to
// the `hyfitgames` schema via search_path. That lets the module's ported raw
// SQL keep using unqualified table names (athletes, events, splits, …) and
// resolve them inside the hyfitgames schema, without touching the host app's
// TypeORM connection.
//
// Mirrors the DB connection settings used by TypeOrmModule.forRoot() in
// app.module.ts (host/port/user/password/name/ssl) so a single set of env vars
// configures both.
@Injectable()
export class HfgDbService implements OnModuleInit, OnModuleDestroy {
  public pool!: Pool;
  private readonly logger = new Logger(HfgDbService.name);

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
      // Pin every connection in this pool to the merged `hyfit` schema. This
      // read `hyfitgames,public` until that schema was dropped; the merge
      // (043-061) moved every table this module uses into `hyfit`.
      options: '-c search_path=hyfit,public',
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      // Keeps idle pooled connections alive at the TCP level. Without it, a
      // NAT or firewall between here and the database silently drops a
      // connection that has been idle for a few minutes — which is precisely
      // what happens to the rest of the pool while a long roster import holds
      // one connection busy.
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

    // MANDATORY, not defensive. `Pool` is an EventEmitter, and it emits
    // 'error' when the database drops a connection sitting idle in the pool —
    // an RDS timeout, a NAT expiry, a failover. An 'error' event with no
    // listener is an uncaught exception in Node, so without this line that
    // routine event KILLS THE WHOLE BACKEND: every request in flight dies with
    // it, and the client sees a socket hang up with nothing logged anywhere.
    //
    // The long roster import is what surfaced it — it holds one connection for
    // minutes while the rest of the pool goes idle — but the crash was never
    // about the import. pg has already discarded the broken client by the time
    // this runs; there is nothing to do here but say so.
    this.pool.on('error', (error) => {
      this.logger.error(
        `Idle Postgres connection dropped: ${error.message}. The pool replaces it; requests in flight are unaffected.`,
      );
    });
  }

  async onModuleDestroy() {
    await this.pool?.end();
  }

  /** Run a query on a pooled connection. */
  q<T extends QueryResultRow = any>(
    text: string,
    params?: unknown[],
  ): Promise<QueryResult<T>> {
    return this.pool.query<T>(text, params as any[]);
  }

  /** Run fn inside a transaction with a dedicated client. */
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
