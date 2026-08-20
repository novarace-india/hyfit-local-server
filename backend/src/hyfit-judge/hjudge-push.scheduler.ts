import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { HjudgePushService } from './services/hjudge-push.service';
import { hjudgeSyncConfig } from './hjudge-sync.config';

/**
 * The clock behind "pull the configuration every N minutes" and "push the
 * results every N minutes".
 *
 * IT RUNS ONLY ON A LOCAL NODE. A prod-role server constructs this and then
 * does nothing with it: there is no timer, no tick, no query. The check is at
 * construction rather than at the module boundary so that the two deployments
 * stay one codebase — the difference between them is a line in an environment
 * file, not a different set of providers.
 *
 * IT IS A TICK, NOT A TIMER PER EVENT. Every `schedulerTickMs` it asks the
 * database which events are due, in each direction, and syncs those. The
 * alternative — a `setInterval` per paired event, created when the interval is
 * saved — has to be torn down and rebuilt on every change, survive a restart,
 * and stay in step with a table that a second process could also be writing. A
 * tick has none of that state: the due-time is a SQL expression over
 * `last_attempt_at`/`interval_minutes` and `last_pull_at`/
 * `pull_interval_minutes`, so changing either takes effect on the next tick,
 * and a restart resumes exactly where the table says it should.
 *
 * PULLS GO FIRST IN EVERY SWEEP, and the order is deliberate. A pull can change
 * the RaceResult configuration this server scores against; pushing standings
 * built from a configuration prod has just superseded, and only then noticing,
 * would publish a snapshot nobody asked for. Doing it the other way round costs
 * one interval of staleness at worst.
 *
 * WHY setInterval AND NOT @nestjs/schedule. Neither backend has that package,
 * and adding a dependency to both to get one recurring callback is a poor
 * trade. `unref()` keeps this loop from holding the process open on shutdown.
 *
 * OVERLAP IS PREVENTED IN TWO PLACES. Here, by not starting a second sweep
 * while one is running; and in `HjudgePushService`, by an in-flight lock per
 * event AND DIRECTION, which is the one that also stops a manual "Sync now"
 * from interleaving with a scheduled one. Two snapshots under two batch ids
 * landing at once would each prune the other's rows.
 */
@Injectable()
export class HjudgePushScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(HjudgePushScheduler.name);
  private timer: NodeJS.Timeout | null = null;
  private sweeping = false;

  constructor(private readonly push: HjudgePushService) {}

  onModuleInit() {
    if (hjudgeSyncConfig.nodeRole !== 'local') return;

    this.timer = setInterval(() => {
      void this.sweep();
    }, hjudgeSyncConfig.schedulerTickMs);
    // Without this the tick keeps Node alive and `npm start` never exits on
    // Ctrl-C — on a venue laptop, where the app is stopped and started by hand
    // between events, that is a daily annoyance.
    this.timer.unref?.();

    this.logger.log(
      `Offline-event sync scheduler running (tick ${Math.round(hjudgeSyncConfig.schedulerTickMs / 1000)}s)`,
    );
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One sweep: whoever is due, in each direction, sequentially.
   *
   *  Sequentially because they share one uplink. Two events syncing at once at
   *  a venue is two transfers competing for the same few hundred kilobits, and
   *  both finish later than they would have one after the other. */
  private async sweep() {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      // Pulls first — see the note on ordering above.
      for (const eventId of await this.push.duePulls()) {
        try {
          const outcome = await this.push.pullConfig(eventId, 'schedule');
          if (outcome.status === 'ok') {
            this.logger.log(
              `Pulled configuration for ${eventId}: ${outcome.message}`,
            );
          }
        } catch (error: any) {
          // Already recorded against the target and in `push_runs` by the
          // service, and the Sync screen is where an operator will see it. One
          // line here so a terminal at the venue shows it too, and the sweep
          // carries on to the next event.
          this.logger.warn(
            `Scheduled pull failed for ${eventId}: ${error?.message ?? error}`,
          );
        }
      }

      for (const eventId of await this.push.due()) {
        try {
          const outcome = await this.push.pushResults(eventId, 'schedule');
          if (outcome.status === 'ok') {
            this.logger.log(
              `Pushed ${outcome.rows} result row(s) for ${eventId} in ${outcome.chunks} chunk(s), ${outcome.durationMs}ms`,
            );
          }
        } catch (error: any) {
          this.logger.warn(
            `Scheduled push failed for ${eventId}: ${error?.message ?? error}`,
          );
        }
      }
    } catch (error: any) {
      this.logger.warn(`Sync sweep failed: ${error?.message ?? error}`);
    } finally {
      this.sweeping = false;
    }
  }
}
