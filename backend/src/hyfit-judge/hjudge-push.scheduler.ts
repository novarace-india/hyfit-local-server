import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { HjudgePushService } from './services/hjudge-push.service';
import { hjudgeSyncConfig } from './hjudge-sync.config';

/**
 * The clock behind "push the results every N minutes".
 *
 * IT RUNS ONLY ON A LOCAL NODE. A prod-role server constructs this and then
 * does nothing with it: there is no timer, no tick, no query. The check is at
 * construction rather than at the module boundary so that the two deployments
 * stay one codebase — the difference between them is a line in an environment
 * file, not a different set of providers.
 *
 * IT IS A TICK, NOT A TIMER PER EVENT. Every `schedulerTickMs` it asks the
 * database which events are due and pushes those. The alternative — a
 * `setInterval` per bound event, created when the dropdown is saved — has to be
 * torn down and rebuilt on every change, survive a restart, and stay in step
 * with a table that a second process could also be writing. A tick has none of
 * that state: the due-time is a SQL expression over `last_attempt_at` and
 * `interval_minutes`, so changing the interval takes effect on the next tick,
 * and a restart resumes exactly where the table says it should.
 *
 * WHY setInterval AND NOT @nestjs/schedule. Neither backend has that package,
 * and adding a dependency to both to get one recurring callback is a poor
 * trade. `unref()` keeps this loop from holding the process open on shutdown.
 *
 * OVERLAP IS PREVENTED IN TWO PLACES. Here, by not starting a second sweep
 * while one is running; and in `HjudgePushService`, by an in-flight lock per
 * event, which is the one that also stops a manual "Push now" from interleaving
 * with a scheduled push. Two snapshots under two batch ids landing at once
 * would each prune the other's rows.
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
      `Offline-event push scheduler running (tick ${Math.round(hjudgeSyncConfig.schedulerTickMs / 1000)}s)`,
    );
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One sweep: whoever is due, in order, sequentially.
   *
   *  Sequentially because they share one uplink. Two events pushing at once at
   *  a venue is two snapshots competing for the same few hundred kilobits, and
   *  both finish later than they would have one after the other. */
  private async sweep() {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      const due = await this.push.due();
      for (const eventId of due) {
        try {
          const outcome = await this.push.pushResults(eventId, 'schedule');
          if (outcome.status === 'ok') {
            this.logger.log(
              `Pushed ${outcome.rows} result row(s) for ${eventId} in ${outcome.chunks} chunk(s), ${outcome.durationMs}ms`,
            );
          }
        } catch (error: any) {
          // Already recorded against the target and in `push_runs` by the
          // service, and the Sync screen is where an operator will see it. One
          // line here so a terminal at the venue shows it too, and the sweep
          // carries on to the next event.
          this.logger.warn(
            `Scheduled push failed for ${eventId}: ${error?.message ?? error}`,
          );
        }
      }
    } catch (error: any) {
      this.logger.warn(`Push sweep failed: ${error?.message ?? error}`);
    } finally {
      this.sweeping = false;
    }
  }
}
