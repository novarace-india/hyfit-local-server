import { Injectable } from '@nestjs/common';
import { CacheService } from '../common/cache/cache.service';

// Thin namespace wrapper around the app-wide Valkey CacheService. Every key the
// HYFIT Games module reads or writes lives under the `hyfitgames:` prefix, so
// all of the module's cached data is grouped together in Valkey and never
// collides with the rest of the Novarace app.
@Injectable()
export class HfgCacheService {
  private readonly NS = 'hyfitgames';

  // TTLs (seconds). The leaderboard is polled every 15s while an event is live,
  // so a short TTL keeps it fresh while still absorbing bursts of viewers.
  private readonly TTL = {
    LEADERBOARD: 15,
    RESULTS: 30,
    EVENT: 30,
    EVENTS_LIST: 60,
  };

  constructor(private readonly cache: CacheService) {}

  private key(...parts: (string | number)[]): string {
    return [this.NS, ...parts].join(':');
  }

  get<T = any>(key: string): Promise<T | null> {
    return this.cache.get<T>(key);
  }

  set<T = any>(key: string, value: T, ttlSeconds: number): Promise<void> {
    return this.cache.set<T>(key, value, ttlSeconds);
  }

  delete(key: string): Promise<void> {
    return this.cache.delete(key);
  }

  // ── keyed helpers ─────────────────────────────────────────────────────────
  eventsListKey(): string {
    return this.key('events', 'list');
  }
  eventKey(eventId: string): string {
    return this.key('ev', eventId, 'detail');
  }
  leaderboardKey(eventId: string, qs: string): string {
    return this.key('ev', eventId, 'lb', qs);
  }
  resultsKey(eventId: string, qs: string): string {
    return this.key('ev', eventId, 'results', qs);
  }

  /* The RaceResult feed an event is serving live, before anything is published.
   *
   * `hyfitgames:{eventId}:live_results` — deliberately NOT under `ev:{id}:`
   * like every other key here, and that is the whole point. `invalidateEvent`
   * wipes `ev:{id}:*` after any write that can change standings, which is
   * correct for entries derived from the database and catastrophic for this
   * one: these rows exist NOWHERE ELSE until the event is published, so a
   * routine cache invalidation would silently discard a race's live standings
   * and there would be nothing to recompute them from.
   *
   * Deleted explicitly, by the live-results service, and only when the feed is
   * discarded or has been persisted.
   */
  liveResultsKey(eventId: string): string {
    return this.key(eventId, 'live_results');
  }

  ttl() {
    return this.TTL;
  }

  /** Drop every cached entry for one event plus the events list. Called after
   * any write that can change standings (splits, results, publish, status). */
  async invalidateEvent(eventId: string): Promise<void> {
    await Promise.all([
      this.cache.deletePattern(this.key('ev', eventId, '*')),
      this.cache.delete(this.eventsListKey()),
    ]);
  }

  /** Drop everything cached by the module (broad admin-side invalidation).
   *
   * Currently unused, and it must stay that way while live results exist: this
   * pattern DOES cover `liveResultsKey`, whose rows are not recoverable from the
   * database. Anything that wants a broad flush should delete the `ev:*` keys
   * and the events list instead of reaching for this. */
  async invalidateAll(): Promise<void> {
    await this.cache.deletePattern(this.key('*'));
  }
}
