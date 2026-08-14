import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';
import { AppLogger } from '../utils/logger';

// Valkey/Redis cache for the HYFIT modules.
//
// This is a trimmed standalone version of the Novarace app-wide CacheService.
// The full one carries the results/leaderboard/certificate helpers that the
// public results site needs, plus TypeORM repositories for cache warm-up —
// none of which exist in this app. The HYFIT modules only ever reach the
// generic key/value surface (get / set / delete / deletePattern), through the
// `hyfitgames:` and `hjudge:` namespace wrappers, so only that surface is kept
// here with the same semantics.
//
// Cluster discovery is gone too: this app runs against a local or single-node
// Valkey. Every method degrades to a no-op when the client is unreachable, so
// the app still serves requests with caching simply disabled — losing the cache
// must never take the field apps down mid-event.
@Injectable()
export class CacheService implements OnModuleInit, OnModuleDestroy {
  public valkeyClient: Redis | null = null;
  private readonly host = process.env.VALKEY_HOST || 'localhost';
  private readonly port = parseInt(process.env.VALKEY_PORT || '6379', 10);
  private readonly enabled = process.env.VALKEY_ENABLED !== 'false';

  onModuleInit() {
    if (!this.enabled) {
      AppLogger.logInfo(
        'Valkey disabled via VALKEY_ENABLED=false, running without cache',
        'CacheService.onModuleInit',
      );
      return;
    }

    try {
      const client = new Redis({
        host: this.host,
        port: this.port,
        // Never queue commands while disconnected: a cache read should fail
        // fast and fall through to Postgres rather than stall the request.
        enableOfflineQueue: false,
        maxRetriesPerRequest: 1,
        retryStrategy: (times) => Math.min(times * 200, 5000),
        lazyConnect: false,
        ...(process.env.VALKEY_TLS === 'true'
          ? { tls: { checkServerIdentity: () => undefined } }
          : {}),
      });

      client.on('ready', () => {
        AppLogger.logInfo('Valkey connected', 'CacheService', {
          host: this.host,
          port: this.port,
        });
      });

      // Logged at warn, not error: an unreachable cache is a degraded state,
      // not a failure. ioredis emits this on every reconnect attempt.
      client.on('error', (error) => {
        AppLogger.logWarn('Valkey error', 'CacheService', {
          host: this.host,
          port: this.port,
          message: error?.message,
        });
      });

      this.valkeyClient = client;
    } catch (error) {
      AppLogger.logError(error, 'CacheService.onModuleInit', {
        host: this.host,
        port: this.port,
      });
    }
  }

  async onModuleDestroy() {
    try {
      this.valkeyClient?.disconnect();
    } catch {
      // Shutting down anyway.
    }
  }

  isAvailable(): boolean {
    return this.valkeyClient !== null && this.valkeyClient.status === 'ready';
  }

  async get<T = any>(key: string): Promise<T | null> {
    if (!this.isAvailable()) return null;

    try {
      const data = await this.valkeyClient!.get(key);
      return data ? (JSON.parse(data) as T) : null;
    } catch (error) {
      AppLogger.logWarn('Cache get failed', 'CacheService.get', {
        key,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  async set<T = any>(key: string, value: T, ttlSeconds: number): Promise<void> {
    if (!this.isAvailable()) return;

    try {
      if (ttlSeconds > 0) {
        await this.valkeyClient!.setex(key, ttlSeconds, JSON.stringify(value));
      } else {
        await this.valkeyClient!.set(key, JSON.stringify(value));
      }
    } catch (error) {
      AppLogger.logWarn('Cache set failed', 'CacheService.set', {
        key,
        ttlSeconds,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async delete(key: string): Promise<void> {
    if (!this.isAvailable()) return;

    try {
      await this.valkeyClient!.del(key);
    } catch (error) {
      AppLogger.logWarn('Cache delete failed', 'CacheService.delete', { key });
    }
  }

  async acquireLock(key: string, ttlMs: number): Promise<boolean> {
    if (!this.isAvailable()) return false;
    try {
      const res = await this.valkeyClient!.set(key, '1', 'PX', ttlMs, 'NX');
      return res === 'OK';
    } catch (error) {
      AppLogger.logWarn('acquireLock failed', 'CacheService.acquireLock', {
        key,
      });
      return false;
    }
  }

  async releaseLock(key: string): Promise<void> {
    if (!this.isAvailable()) return;
    try {
      await this.valkeyClient!.del(key);
    } catch (error) {
      AppLogger.logWarn('releaseLock failed', 'CacheService.releaseLock', {
        key,
      });
    }
  }

  /** SCAN rather than KEYS — KEYS blocks the server for the whole sweep. */
  async scanKeys(pattern: string): Promise<string[]> {
    if (!this.isAvailable()) return [];

    const keys: string[] = [];
    try {
      let cursor = '0';
      do {
        const [newCursor, scannedKeys] = await this.valkeyClient!.scan(
          cursor,
          'MATCH',
          pattern,
          'COUNT',
          100,
        );
        if (scannedKeys && scannedKeys.length > 0) {
          keys.push(...scannedKeys);
        }
        cursor = newCursor;
      } while (cursor !== '0');
    } catch (error) {
      AppLogger.logWarn('Cache scanKeys failed', 'CacheService.scanKeys', {
        pattern,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return Array.from(new Set(keys));
  }

  async deletePattern(pattern: string): Promise<void> {
    if (!this.isAvailable()) return;

    try {
      const keys = await this.scanKeys(pattern);
      if (keys.length > 0) {
        const pipeline = this.valkeyClient!.pipeline();
        for (const key of keys) {
          pipeline.del(key);
        }
        await pipeline.exec();
      }
    } catch (error) {
      AppLogger.logWarn(
        'Cache deletePattern failed',
        'CacheService.deletePattern',
        {
          pattern,
          error: error instanceof Error ? error.message : String(error),
        },
      );
    }
  }
}
