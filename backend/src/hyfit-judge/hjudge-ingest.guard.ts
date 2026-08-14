import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { HjudgeDbService } from './hjudge-db.service';
import { bearerToken, tokenHash } from './hjudge-session.util';
import { hjudgeSyncConfig, type HjudgeIngestScope } from './hjudge-sync.config';

/** What the guard resolved the credential to. Handlers read this instead of the
 *  event id in the URL — see the note on `eventId` below. */
export interface HjudgeIngestPrincipal {
  tokenId: string;
  /** The event this credential may write, as PROD holds it. */
  eventId: string;
  eventName: string;
  scopes: HjudgeIngestScope[];
  label: string;
  expiresAt: string;
}

/**
 * The only credential in this system that is not a person.
 *
 * A local server at a venue has no login, no session and nobody sitting at it
 * to complete one. It has a bearer token that prod minted for exactly one
 * offline event, and this guard is the entire boundary around what that token
 * can reach.
 *
 * FOUR THINGS ARE CHECKED, AND THE ORDER MATTERS LESS THAN THE FACT THAT ALL
 * FOUR ARE:
 *
 *   1. the token exists — looked up by SHA-256, never by the value itself, so
 *      the secret is not in the database to be read out of it;
 *   2. it is live — not revoked, not past its expiry. Both are checked in SQL
 *      rather than in Node, so a clock this process disagrees with cannot let a
 *      dead credential through;
 *   3. the event it names is still `delivery_mode = 'offline'`. Switching an
 *      event back to online is how an operator says "prod runs this now", and
 *      it has to stop the venue's pushes immediately, without anybody
 *      remembering to also revoke a token;
 *   4. the route's scope is one the credential carries.
 *
 * THE EVENT ID IN THE URL IS NOT TRUSTED. It is compared against the
 * credential's event and a mismatch is refused, but what the handler acts on is
 * `principal.eventId` — the one the token was minted for. A guard that checked
 * the URL and then let the handler re-read the URL is a guard with a gap in it
 * the width of one refactor.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. It does not open a session, it does not
 * set `request.user`, and nothing outside the ingest controller consults it. A
 * credential that could stand in for a staff account would be a way into
 * check-in and judging, which is precisely what an event's public results feed
 * has no business being able to reach.
 */
@Injectable()
export class HjudgeIngestGuard implements CanActivate {
  constructor(private readonly db: HjudgeDbService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // A local-role server has no business accepting pushes: it IS the venue.
    // Refusing here rather than at the route means a misconfigured pair fails
    // with something an operator can act on instead of quietly writing the
    // standings into the laptop they came from.
    if (hjudgeSyncConfig.nodeRole !== 'prod') {
      throw new ForbiddenException(
        'This server runs as a local node and does not accept pushes',
      );
    }

    const request = context.switchToHttp().getRequest();
    const presented = bearerToken(request.headers?.authorization ?? '');
    if (!presented) {
      throw new UnauthorizedException('A sync credential is required');
    }

    const row = await this.db.q1<{
      id: string;
      event_id: string;
      event_name: string;
      label: string;
      scopes: string[];
      expires_at: string;
      revoked_at: string | null;
      delivery_mode: string;
      expired: boolean;
    }>(
      `SELECT t.id, t.event_id, e.name AS event_name, t.label, t.scopes,
              t.expires_at, t.revoked_at, e.delivery_mode,
              (t.expires_at <= now()) AS expired
         FROM event_ingest_tokens t
         JOIN events e ON e.id = t.event_id
        WHERE t.token_hash = $1`,
      [tokenHash(presented)],
    );

    // One message for "no such token", "revoked" and "expired". Which of the
    // three it is tells an unauthenticated caller something, and tells the
    // operator holding a real credential nothing they cannot see on the Sync
    // screen, where the same three states are named plainly.
    if (!row || row.revoked_at || row.expired) {
      throw new UnauthorizedException('Sync credential is not valid');
    }

    if (row.delivery_mode !== 'offline') {
      throw new ForbiddenException(
        `"${row.event_name}" is not an offline event here — nothing may be pushed into it`,
      );
    }

    const scopes = (row.scopes ?? []) as HjudgeIngestScope[];
    const required = this.requiredScope(request);
    if (required && !scopes.includes(required)) {
      throw new ForbiddenException(
        `This credential may not push ${required} for "${row.event_name}"`,
      );
    }

    const urlEventId = String(request.params?.eventId ?? '').trim();
    if (urlEventId && urlEventId !== row.event_id) {
      throw new ForbiddenException(
        'This credential belongs to a different event',
      );
    }

    const principal: HjudgeIngestPrincipal = {
      tokenId: row.id,
      eventId: row.event_id,
      eventName: row.event_name,
      scopes,
      label: row.label ?? '',
      expiresAt: row.expires_at,
    };
    (request as { hjudgeIngest?: HjudgeIngestPrincipal }).hjudgeIngest =
      principal;

    // Fire-and-forget: "when did the venue last reach us" is worth having on
    // the console, and it is not worth failing a push over. An UPDATE that
    // cannot run does not make the roster any less valid.
    void this.db
      .q(
        `UPDATE event_ingest_tokens
            SET last_used_at = now(),
                last_used_ip = $2,
                use_count    = use_count + 1
          WHERE id = $1`,
        [row.id, this.clientIp(request)],
      )
      .catch(() => undefined);

    return true;
  }

  /** Which scope the route being called needs, from the route itself. The three
   *  ingest paths end in the thing they write, so this is a read of the URL
   *  rather than a second list to keep in step with the controller. */
  private requiredScope(request: {
    path?: string;
    url?: string;
  }): HjudgeIngestScope | null {
    const path = String(request.path ?? request.url ?? '');
    if (path.includes('/athletes')) return 'athletes';
    if (path.includes('/results')) return 'results';
    return null;
  }

  private clientIp(request: {
    headers?: Record<string, unknown>;
    ip?: string;
  }): string {
    const forwarded = request.headers?.['x-forwarded-for'];
    const first = Array.isArray(forwarded)
      ? forwarded[0]
      : String(forwarded ?? '').split(',')[0];
    return (first || request.ip || '').toString().trim().slice(0, 64);
  }
}
