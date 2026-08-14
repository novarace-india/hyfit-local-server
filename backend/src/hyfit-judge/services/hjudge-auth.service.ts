import { Injectable, UnauthorizedException } from '@nestjs/common';
import { HjudgeDbService } from '../hjudge-db.service';
import {
  hashPin,
  verifyPin,
  newSessionToken,
  tokenHash,
} from '../hjudge-session.util';
import { hjudgeConfig } from '../hjudge.config';
import { HjudgeUser } from '../hjudge-auth.guard';
import type { Request, Response } from 'express';

@Injectable()
export class HjudgeAuthService {
  constructor(private readonly db: HjudgeDbService) {}

  async login(
    staffId: string,
    pin: string,
    deviceLabel: string,
    ip: string,
    response: Response,
    // Native clients can't read an HttpOnly cookie, so they opt in to having
    // the raw session token in the response body. Left false for browsers so
    // the token stays out of reach of any JavaScript on the page.
    issueBearerToken = false,
    // Which app is signing in. Check-in keeps its own cookie and its own list
    // of roles allowed through, so the two field apps can be signed in side by
    // side on one device and neither can be entered with the other's staff ID.
    audience: 'judge' | 'checkin' = 'judge',
  ) {
    const normalizedStaffId = staffId.trim().toUpperCase();
    if (!normalizedStaffId || !/^\d{4,8}$/.test(pin)) {
      throw new UnauthorizedException('Enter a valid staff ID and PIN');
    }

    // Field staff, in hyfit_v2.users (080). A row matching a staff_id always
    // has a pin_hash: hyfit_v2_users_staff_credential_pair makes that pair
    // all-or-nothing, so a console-only operator — email and password, no staff
    // ID — can never match here.
    const found = await this.db.q<{
      id: string;
      staffId: string;
      name: string;
      pinHash: string;
      role: string;
      eventId: string | null;
      platformEventId: string | null;
    }>(
      // platformEventId travels with the login so a tablet provisioned before
      // the cutover can still match its config code against this event.
      `SELECT u.id, u.staff_id AS "staffId", u.name, u.pin_hash AS "pinHash",
              u.role, u.event_id AS "eventId",
              (SELECT ev.platform_event_id FROM events ev WHERE ev.id = u.event_id)
                AS "platformEventId"
       FROM users u WHERE u.staff_id = $1 AND u.enabled = true`,
      [normalizedStaffId],
    );

    const user = found.rows[0];
    if (!user || !verifyPin(pin, user.pinHash)) {
      // Brute-force protection
      await new Promise((resolve) => setTimeout(resolve, 350));
      throw new UnauthorizedException('Staff ID or PIN is incorrect');
    }

    // Said at the door. A judge who types their PIN into the counter would
    // otherwise get a session that fails on the counter's very first call, and
    // the volunteer in front of them has no way to read that as "wrong app".
    if (
      audience === 'checkin' &&
      !(hjudgeConfig.checkinRoles as readonly string[]).includes(user.role)
    ) {
      throw new UnauthorizedException(
        'This staff ID is not assigned to check-in. Judges sign in at the judge app.',
      );
    }

    await this.db.q('UPDATE users SET last_login_at = now() WHERE id = $1', [
      user.id,
    ]);

    const token = newSessionToken();
    const created = await this.db.q<{ expiresAt: string }>(
      `INSERT INTO sessions(user_id, token_hash, device_label, ip_address, audience, expires_at)
       VALUES($1, $2, $3, $4, $5, now() + interval '12 hours')
       RETURNING expires_at AS "expiresAt"`,
      [user.id, tokenHash(token), deviceLabel.slice(0, 120), ip, audience],
    );

    await this.db.q(
      `INSERT INTO audit_events(actor_id, event_id, action, entity_type, entity_id)
       VALUES($1, $2, 'login', 'session', $3)`,
      [user.id, user.eventId, tokenHash(token).slice(0, 12)],
    );

    this.setSessionCookie(response, token, this.cookieFor(audience));

    return {
      user: {
        id: user.id,
        staffId: user.staffId,
        name: user.name,
        role: user.role,
        eventId: user.eventId,
        platformEventId: user.platformEventId,
      },
      ...(issueBearerToken
        ? { token, expiresAt: created.rows[0]?.expiresAt ?? null }
        : {}),
    };
  }

  // Opens a field session for a user the caller has ALREADY authenticated by
  // another means. The admin console signs in with email + password against
  // `hyfit_v2.users`; this opens the field session that goes with it, so the
  // merged console does not ask an operator to sign in twice — once to reach
  // the athlete screens and again to reach Team and Operations.
  //
  // The caller is trusted to have verified the password; this method never
  // accepts a credential of its own, which is why it is not reachable over HTTP.
  // No privilege is created either — the session carries the role on the field
  // row, and every judge route still runs its own role guard.
  //
  // `userId` is a hyfit_v2.users id — the console authenticates against that
  // table too since 080, so the operator's console identity and their field
  // identity are one row and there is nothing to match up.
  //
  // A staff ID is deliberately NOT required. `sessions.user_id` references the
  // row, not the staff credential, so a console operator who has never been
  // issued a PIN can still hold a field session — and requiring one is what
  // broke Team and Operations before.
  //
  // Returns null when the row is missing or disabled, so the console can tell
  // "no field access" apart from "the session failed".
  async openLinkedSession(
    userId: string,
    deviceLabel: string,
    ip: string,
    response: Response,
  ) {
    // Same active-event fallback as HjudgeAuthGuard, and for the same reason:
    // a console account is global, so its row carries no event_id.
    const found = await this.db.q<{
      id: string;
      staffId: string | null;
      name: string;
      role: string;
      eventId: string | null;
    }>(
      `SELECT u.id, u.staff_id AS "staffId", u.name, u.role,
              COALESCE(u.event_id, (SELECT e.id FROM events e WHERE e.is_active)) AS "eventId"
       FROM users u
       WHERE u.id = $1 AND u.enabled = true`,
      [userId],
    );

    const user = found.rows[0];
    if (!user) return null;

    // A judge-audience session and nothing else. This exists so the console's
    // own screens — Team, Operations — do not demand a second credential, and
    // it deliberately stops there: check-in is a separate authentication, and
    // minting a counter session off the back of a console login would mean
    // anyone who had opened the admin console on a tablet was silently already
    // signed in at the counter. A counter is signed in at by the person
    // working it, with the staff ID and PIN issued for that shift.
    const token = newSessionToken();
    await this.db.q(
      `INSERT INTO sessions(user_id, token_hash, device_label, ip_address, audience, expires_at)
       VALUES($1, $2, $3, $4, 'judge', now() + interval '${hjudgeConfig.sessionMaxAgeHours} hours')`,
      [user.id, tokenHash(token), deviceLabel.slice(0, 120), ip],
    );
    await this.db.q(
      `INSERT INTO audit_events(actor_id, event_id, action, entity_type, entity_id)
       VALUES($1, $2, 'login', 'session', $3)`,
      [user.id, user.eventId, tokenHash(token).slice(0, 12)],
    );

    this.setSessionCookie(response, token);

    return {
      id: user.id,
      staffId: user.staffId,
      name: user.name,
      role: user.role,
      eventId: user.eventId,
    };
  }

  private cookieFor(audience: 'judge' | 'checkin') {
    return audience === 'checkin'
      ? hjudgeConfig.checkinCookieName
      : hjudgeConfig.sessionCookieName;
  }

  private sessionCookie(token: string, cookieName: string) {
    const isSecure = hjudgeConfig.isProd;
    return `${cookieName}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${hjudgeConfig.sessionMaxAgeHours * 3600}${isSecure ? '; Secure' : ''}`;
  }

  private setSessionCookie(
    response: Response,
    token: string,
    cookieName: string = hjudgeConfig.sessionCookieName,
  ) {
    response.setHeader('Set-Cookie', this.sessionCookie(token, cookieName));
  }

  // Sessions live 12 hours, which covers a single event day but expires in the
  // middle of a multi-day event. Any authenticated call can push the window
  // out so an app that's actively in use never logs a judge out mid-race.
  async refresh(user: HjudgeUser) {
    const updated = await this.db.q<{ expiresAt: string }>(
      `UPDATE sessions
          SET expires_at = now() + interval '${hjudgeConfig.sessionMaxAgeHours} hours'
        WHERE id = $1 AND revoked_at IS NULL AND expires_at > now()
      RETURNING expires_at AS "expiresAt"`,
      [user.sessionId],
    );

    if (!updated.rows[0]) {
      throw new UnauthorizedException('Session is no longer valid');
    }

    return { expiresAt: updated.rows[0].expiresAt };
  }

  async logout(
    user: HjudgeUser,
    response: Response,
    audience: 'judge' | 'checkin' = 'judge',
  ) {
    // Revokes only the session that made this call, not every session the user
    // has. Previously this signed the account out everywhere, which was
    // survivable when the web app was the only client but isn't once a judge
    // can carry a phone and a tablet — signing out one device would drop the
    // other mid-race.
    await this.db.q(
      `UPDATE sessions SET revoked_at = now()
        WHERE id = $1 AND revoked_at IS NULL`,
      [user.sessionId],
    );
    await this.db.q(
      `INSERT INTO audit_events(actor_id, event_id, action, entity_type)
       VALUES($1, $2, 'logout', 'session')`,
      [user.id, user.eventId],
    );

    // Clears only this app's cookie: signing out of a counter must not end the
    // judge session sitting beside it on the same device.
    response.setHeader(
      'Set-Cookie',
      `${this.cookieFor(audience)}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
    );

    return { ok: true };
  }

  getSession(user: HjudgeUser) {
    return {
      user: {
        id: user.id,
        staffId: user.staffId,
        name: user.name,
        role: user.role,
        eventId: user.eventId,
        platformEventId: user.platformEventId,
        // The console's event picker needs to know whether this account may
        // move between events at all. Null means a global console admin;
        // non-null means field staff hired for that one event, for whom every
        // other event is a 403 — better shown as a fixed label than as a
        // dropdown that fails on use.
        boundEventId: user.boundEventId,
      },
    };
  }
}
