import { Module } from '@nestjs/common';
import { CacheService } from './cache.service';

// In Novarace this module also registers TypeORM repositories, which the
// app-wide CacheService uses to warm the public results pages. This app has no
// TypeORM connection and no results pages, so the module is just the provider.
@Module({
  providers: [CacheService],
  exports: [CacheService],
})
export class CacheModule {}
