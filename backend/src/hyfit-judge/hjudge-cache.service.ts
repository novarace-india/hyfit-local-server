import { Injectable } from '@nestjs/common';
import { CacheService } from '../common/cache/cache.service';

@Injectable()
export class HjudgeCacheService {
  private readonly NS = 'hjudge';

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

  eventsListKey(): string {
    return this.key('events', 'list');
  }

  eventKey(eventId: string): string {
    return this.key('ev', eventId, 'detail');
  }

  ttl() {
    return this.TTL;
  }

  async invalidateEvent(eventId: string): Promise<void> {
    await Promise.all([
      this.cache.deletePattern(this.key('ev', eventId, '*')),
      this.cache.delete(this.eventsListKey()),
    ]);
  }

  async invalidateAll(): Promise<void> {
    await this.cache.deletePattern(this.key('*'));
  }
}
