import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { HjudgeDbService } from './hjudge-db.service';
import { bearerToken, parseCookies, tokenHash } from './hjudge-session.util';
import { hjudgeConfig } from './hjudge.config';

export interface HjudgeUser {
  id: string;
  staffId: string;
  name: string;
  role: string;
  /** The event this request acts on: the account's own event when it has one,
   *  otherwise the active event. Admin routes may narrow it to the event named
   *  in the URL — see `scopeTo` in hjudge-admin.controller.ts. */
  eventId: string | null;
  /** The account's OWN event, before that fallback. Null for a console admin,
   *  who is global; non-null for field staff, who are hired for one event and
   *  must not be able to reach another by putting its id in a URL. */
  boundEventId: string | null;
  /** The same event's id on the athlete platform, when it has one. Carried so
   *  a device provisioned before the cutover — whose config code holds that id
   *  — is still recognised as being set up for this event. */
  platformEventId: string | null;
  /** Which check-in shift this person is rostered onto, as the Team screen set
   *  it. Reported to the counter so a volunteer can see whose shift the tablet
   *  is signed in to; it decides nothing. What is handed over is the athlete's
   *  to determine — whichever of the two they have not had — so no route reads
   *  this to permit or refuse a check-in. Null for a judge, for an admin
   *  standing in, and for a volunteer nobody has rostered yet. */
  checkinStage: string | null;
  sessionId: string;
  deviceLabel: string;
  ipAddress: string;
}

@Injectable()
export class HjudgeAuthGuard implements CanActivate {
  constructor(protected readonly db: HjudgeDbService) {}

  /** Cookie names this guard will accept, in order of preference. Subclasses
   *  narrow it to the app they belong to. */
  protected cookieNames(): string[] {
    return [hjudgeConfig.sessionCookieName];
  }

  /** The app this guard defends. A session minted for the other one is not a
   *  credential here, whatever the role on it says. */
  protected audience(): 'judge' | 'checkin' {
    return 'judge';
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const response = context.switchToHttp().getResponse();

    // Browsers send the session in an HttpOnly cookie; native clients send the
    // same token as `Authorization: Bearer`. Cookie wins when both are present
    // so a stale bearer header on a web request can't shadow a live session.
    const cookieHeader = request.headers?.cookie ?? '';
    const cookies = parseCookies(cookieHeader);
    const token =
      this.cookieNames()
        .map((name) => cookies.get(name))
        .find((value) => Boolean(value)) ||
      bearerToken(request.headers?.authorization ?? '');

    if (!token) {
      throw new UnauthorizedException('Authentication required');
    }

    // Unqualified, so both resolve inside hyfit_v2 (080): sessions, the staff
    // row behind them, and the event.
    //
    // event_id falls back to the active event because a console account is
    // global: hyfit_v2.users.event_id is null for anyone not hired for one
    // event, and almost every admin route reads the caller's event_id as the
    // event it acts on (`eventId ?? user.eventId`). Without the fallback an
    // operator who signed in through /hyfitgames/admin gets a valid session
    // whose every event-scoped call quietly resolves to nothing.
    // `is_active` is a singleton (hyfit_v2_events_one_active), so this picks
    // the one event field ops is currently running.
    const result = await this.db.q<HjudgeUser>(
      `SELECT u.id, u.staff_id AS "staffId", u.name, u.role,
        COALESCE(u.event_id, (SELECT e.id FROM events e WHERE e.is_active)) AS "eventId",
        u.event_id AS "boundEventId", u.checkin_stage AS "checkinStage",
        (SELECT ev.platform_event_id FROM events ev
          WHERE ev.id = COALESCE(u.event_id, (SELECT e2.id FROM events e2 WHERE e2.is_active)))
          AS "platformEventId",
        s.id AS "sessionId", COALESCE(s.device_label,'') AS "deviceLabel",
        COALESCE(s.ip_address,'') AS "ipAddress"
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.audience = $2
         AND s.revoked_at IS NULL AND s.expires_at > now() AND u.enabled = true`,
      [tokenHash(token), this.audience()],
    );

    if (!result.rows[0]) {
      throw new UnauthorizedException('Authentication required');
    }

    // Touch last_seen_at
    await this.db.q(
      'UPDATE sessions SET last_seen_at = now() WHERE token_hash = $1',
      [tokenHash(token)],
    );

    request.hjudgeUser = result.rows[0];
    return true;
  }
}

/** The counter's own session — a separate authentication, not a second door
 *  into the same one.
 *
 *  Its own cookie, so signing in at a counter neither ends nor inherits a
 *  judge's shift on the same device, AND its own audience, so a judge session
 *  copied into this cookie is refused outright rather than being let through
 *  on the strength of the person's role. A console sign-in does NOT open one:
 *  `openLinkedSession` mints a judge session only, because a counter is
 *  answerable for who handed which wristband to which athlete and that name has
 *  to come from someone who signed in to do the job. */
@Injectable()
export class HjudgeCheckinAuthGuard extends HjudgeAuthGuard {
  protected cookieNames(): string[] {
    return [hjudgeConfig.checkinCookieName];
  }

  protected audience(): 'judge' | 'checkin' {
    return 'checkin';
  }
}
