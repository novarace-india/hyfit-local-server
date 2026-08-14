import {
  BadRequestException,
  Body,
  Controller,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import * as crypto from 'node:crypto';
import * as bcrypt from 'bcrypt';
import { Public } from '../../common/decorators/public.decorator';
import { HfgAdminGuard } from '../guards/hfg-admin.guard';
import { HfgAthleteGuard } from '../guards/hfg-athlete.guard';
import { HfgAdminId, HfgAthleteId } from '../decorators/hfg-user.decorator';
import { HfgDbService } from '../hfg-db.service';
import { hfgConfig } from '../hfg.config';
import { signAccess } from '../hfg-jwt.util';
import { HfgOtpService } from '../services/hfg-otp.service';
import { HjudgeAuthService } from '../../hyfit-judge/services/hjudge-auth.service';
import { publicAthleteV2 } from '../hfg.util';

// HYFIT Games auth. All routes are @Public() so the host app's global
// JwtAuthGuard/RolesGuard don't intercept them — the module verifies its own
// mobile+OTP / admin sessions. Mounted under /api/hyfitgames/auth.
@Public()
@Controller('hyfitgames/auth')
export class HfgAuthController {
  constructor(
    private readonly db: HfgDbService,
    private readonly otp: HfgOtpService,
    private readonly judgeAuth: HjudgeAuthService,
  ) {}

  // Two token stores, because the two identities are two different things: an
  // athlete is a person who races, a console operator is a staff account.
  // `hyfit_v2.refresh_tokens.user_id` references hyfit_v2.users, which an
  // athlete is not a row in — hence a table each, and each token written beside
  // the row it belongs to.
  private async issueRefresh(opts: {
    athleteId?: string | null;
    adminId?: string | null;
  }): Promise<string> {
    const raw = crypto.randomBytes(32).toString('hex');
    const hash = crypto.createHash('sha256').update(raw).digest('hex');
    if (opts.adminId) {
      await this.db.q(
        `INSERT INTO hyfit_v2.refresh_tokens (user_id, token_hash, expires_at)
         VALUES ($1, $2, now() + ($3 || ' days')::interval)`,
        [opts.adminId, hash, hfgConfig.refreshTtlDays],
      );
    } else {
      await this.db.q(
        `INSERT INTO hyfit_v2.athlete_refresh_tokens (athlete_id, token_hash, expires_at)
         VALUES ($1, $2, now() + ($3 || ' days')::interval)`,
        [opts.athleteId ?? null, hash, hfgConfig.refreshTtlDays],
      );
    }
    return raw;
  }

  /* Everyone this number belongs to.
   *
   * A number can hold SEVERAL athletes, and that is a direct consequence of the
   * identity being phone + name (migration 084): a parent enters two children
   * on their own number and those are two people, not one. So the login proves
   * the NUMBER and then says which of them is signing in.
   *
   * Matched on `mobile_key` — digits only, last ten — rather than on the stored
   * string, because the number an athlete types is not spelled the way the
   * organiser's export spelled it, and requiring that would lock out most of
   * the field. All queries here are schema-qualified: this pool's search_path
   * is the athlete platform's dropped schema, so every table has to be named.
   */
  private async athletesOnNumber(mobile: string) {
    // ONE ROW PER NAME, not per entry. Since 085 the table holds a row per
    // athlete per category per event, so a number that raced three contests
    // would otherwise offer three identical "profiles" to sign in as. DISTINCT
    // ON collapses them to the person, and the row it keeps is the newest —
    // the most recent spelling of their profile.
    const { rows } = await this.db.q(
      `SELECT DISTINCT ON (hyfit_v2.name_key(name))
              id, name, mobile, email, gender, date_of_birth, city, is_active
         FROM hyfit_v2.athletes
        WHERE hyfit_v2.mobile_key(mobile) = hyfit_v2.mobile_key($1)
          AND is_active
        ORDER BY hyfit_v2.name_key(name), created_at DESC`,
      [mobile],
    );
    return rows;
  }

  /* POST /api/hyfitgames/auth/otp/request  { mobile } */
  @Post('otp/request')
  async otpRequest(@Body() body: { mobile?: string }) {
    const mobile = this.otp.normalizeMobile(body.mobile);
    if (!mobile) throw new BadRequestException('Enter a valid mobile number');

    const athletes = await this.athletesOnNumber(mobile);
    if (!athletes.length)
      throw new BadRequestException(
        'This number is not registered. Contact the organiser.',
      );
    await this.otp.requestOtp(mobile);
    return { ok: true, message: 'OTP sent' };
  }

  /* POST /api/hyfitgames/auth/otp/verify  { mobile, code, athleteId? }
   *
   * Signs in as the one athlete on the number, or as the named one when the
   * number holds several. `profiles` comes back either way so the client can
   * offer the switch without a second round trip. */
  @Post('otp/verify')
  async otpVerify(
    @Body() body: { mobile?: string; code?: string; athleteId?: string },
  ) {
    const mobile = this.otp.normalizeMobile(body.mobile);
    if (!mobile || !/^\d{6}$/.test(String(body.code || '')))
      throw new BadRequestException('Enter the 6-digit OTP');

    const athletes = await this.athletesOnNumber(mobile);
    if (!athletes.length)
      throw new BadRequestException(
        'This number is not registered. Contact the organiser.',
      );

    // The chosen profile must be ON this number. Without the check, a valid OTP
    // for one number would mint a token for any athlete id the caller cared to
    // name — which is every account on the platform.
    const chosen = body.athleteId
      ? athletes.find((a) => a.id === body.athleteId)
      : athletes[0];
    if (!chosen)
      throw new BadRequestException('That profile is not on this number');

    // Consumed only once the profile has been resolved, so a bad athleteId does
    // not burn the code the athlete just received.
    await this.otp.verifyOtp(mobile, body.code);
    // Stamped across every row this person holds, not just the one the token
    // will name: they are one athlete signing in, however many contests they
    // have entered.
    await this.db.q(
      `UPDATE hyfit_v2.athletes SET last_login_at = now()
        WHERE hyfit_v2.mobile_key(mobile) = hyfit_v2.mobile_key($1)
          AND hyfit_v2.name_key(name) = hyfit_v2.name_key($2)`,
      [chosen.mobile, chosen.name],
    );

    const accessToken = await signAccess('athlete', chosen.id);
    const refreshToken = await this.issueRefresh({ athleteId: chosen.id });
    return {
      accessToken,
      refreshToken,
      athlete: publicAthleteV2(chosen),
      profiles: athletes.map((a) => ({ id: a.id, full_name: a.name })),
    };
  }

  /* POST /api/hyfitgames/auth/profile/switch  { athleteId }
   *
   * Move to another person on the SAME number without a second OTP. The number
   * was already proved at login and has not changed; asking for a code again
   * would only be theatre. The token's own athlete decides which number that
   * is, so this cannot reach an account the caller has not authenticated. */
  @Post('profile/switch')
  @UseGuards(HfgAthleteGuard)
  async switchProfile(
    @HfgAthleteId() athleteId: string,
    @Body() body: { athleteId?: string },
  ) {
    const { rows } = await this.db.q(
      `SELECT t.id, t.name, t.mobile, t.email, t.gender, t.date_of_birth, t.city
         FROM hyfit_v2.athletes me
         JOIN hyfit_v2.athletes t
           ON hyfit_v2.mobile_key(t.mobile) = hyfit_v2.mobile_key(me.mobile)
          AND hyfit_v2.mobile_key(me.mobile) <> ''
        WHERE me.id = $1 AND t.id = $2 AND t.is_active`,
      [athleteId, String(body.athleteId ?? '')],
    );
    const target = rows[0];
    if (!target)
      throw new UnauthorizedException('That profile is not on your number');

    const accessToken = await signAccess('athlete', target.id);
    const refreshToken = await this.issueRefresh({ athleteId: target.id });
    return { accessToken, refreshToken, athlete: publicAthleteV2(target) };
  }

  /* POST /api/hyfitgames/auth/refresh  { refreshToken } */
  @Post('refresh')
  async refresh(@Body() body: { refreshToken?: string }) {
    const raw = String(body.refreshToken || '');
    const hash = crypto.createHash('sha256').update(raw).digest('hex');

    // The console's store first. A token is in exactly one of the two, and the
    // client cannot tell us which — it holds an opaque string.
    const console_ = await this.db.q(
      `SELECT id, user_id FROM hyfit_v2.refresh_tokens
        WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()`,
      [hash],
    );

    if (console_.rows[0]) {
      const token = console_.rows[0];
      await this.db.q(
        'UPDATE hyfit_v2.refresh_tokens SET revoked_at = now() WHERE id = $1',
        [token.id],
      );
      // The role is re-read on every rotation so a role change or a disabled
      // account takes effect at the next refresh rather than lasting as long as
      // the refresh token. A missing row must not silently mint a token.
      const { rows: a } = await this.db.q(
        'SELECT role FROM hyfit_v2.users WHERE id = $1 AND enabled = true',
        [token.user_id],
      );
      if (!a[0])
        throw new UnauthorizedException(
          'Session expired — please log in again',
        );
      const accessToken = await signAccess('admin', token.user_id, {
        role: a[0].role,
      });
      const refreshToken = await this.issueRefresh({ adminId: token.user_id });
      return { accessToken, refreshToken };
    }

    const { rows } = await this.db.q(
      `SELECT t.id, t.athlete_id
         FROM hyfit_v2.athlete_refresh_tokens t
         JOIN hyfit_v2.athletes a ON a.id = t.athlete_id AND a.is_active
        WHERE t.token_hash = $1 AND t.revoked_at IS NULL AND t.expires_at > now()`,
      [hash],
    );
    const t = rows[0];
    // Joined to the athlete rather than read alone, so an account disabled by
    // the organiser stops at the next rotation instead of living as long as the
    // refresh token — the same rule the console's branch above applies.
    if (!t)
      throw new UnauthorizedException('Session expired — please log in again');

    // rotate
    await this.db.q(
      'UPDATE hyfit_v2.athlete_refresh_tokens SET revoked_at = now() WHERE id = $1',
      [t.id],
    );
    const accessToken = await signAccess('athlete', t.athlete_id);
    const refreshToken = await this.issueRefresh({ athleteId: t.athlete_id });
    return { accessToken, refreshToken };
  }

  /* POST /api/hyfitgames/auth/logout  { refreshToken } */
  @Post('logout')
  async logout(@Body() body: { refreshToken?: string }) {
    const hash = crypto
      .createHash('sha256')
      .update(String(body.refreshToken || ''))
      .digest('hex');
    // Both stores: the caller holds an opaque string and cannot say which of
    // the two it came from, and a logout that silently misses is a session that
    // stays alive after someone was told it had ended.
    await this.db.q(
      'UPDATE hyfit_v2.refresh_tokens SET revoked_at = now() WHERE token_hash = $1',
      [hash],
    );
    await this.db.q(
      'UPDATE hyfit_v2.athlete_refresh_tokens SET revoked_at = now() WHERE token_hash = $1',
      [hash],
    );
    return { ok: true };
  }

  /* POST /api/hyfitgames/auth/admin/login  { email, password } */
  // Authenticates against `hyfit_v2.users`, which is where every HYFIT
  // credential lives since 080 — the console's email and password on the same
  // row as the field staff ID and PIN, when a person has both. Schema-qualified
  // because this pool's search_path is pinned to the athlete platform; only the
  // identity lookup crosses over.
  //
  // The role in the JWT is one of the canonical roles (super_admin/event_admin
  // here); nothing reads it — HfgAdminGuard only checks the token type.
  //
  // The console also hosts the field-operations screens, so a successful
  // sign-in additionally opens the judge session those screens call with —
  // same row, same role, no second credential. `field` is null only for a row
  // that vanished or was disabled between the two queries.
  @Post('admin/login')
  async adminLogin(
    @Body() body: { email?: string; password?: string },
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { rows } = await this.db.q(
      `SELECT id, name, email, password_hash, role
         FROM hyfit_v2.users WHERE email = $1 AND enabled = true`,
      [String(body.email || '').toLowerCase()],
    );
    const admin = rows[0];
    if (
      !admin ||
      !(await bcrypt.compare(String(body.password || ''), admin.password_hash))
    )
      throw new UnauthorizedException('Invalid email or password');
    await this.db.q(
      'UPDATE hyfit_v2.users SET last_login_at = now() WHERE id = $1',
      [admin.id],
    );
    const accessToken = await signAccess('admin', admin.id, {
      role: admin.role,
    });
    const refreshToken = await this.issueRefresh({ adminId: admin.id });
    const field = await this.judgeAuth.openLinkedSession(
      admin.id,
      String(request.headers['user-agent'] ?? 'admin console'),
      request.ip ?? '',
      response,
    );
    return {
      accessToken,
      refreshToken,
      admin: { id: admin.id, email: admin.email, role: admin.role },
      field,
    };
  }

  /* POST /api/hyfitgames/auth/admin/field-session
   *
   * Re-opens the field session for a console that is already signed in. Login
   * alone is not enough: the console session is renewed from a refresh token
   * that outlives the 12-hour field session, and a browser that signed in
   * before this endpoint existed holds an admin token and no field cookie at
   * all. In both cases Team and Operations would sit behind a staff-ID prompt
   * that a console-only account can never answer. The console calls this
   * whenever it finds no field session, and gets one back on the same terms as
   * login — the admin JWT proves the identity, the row's own role decides what
   * the session may do.
   */
  @Post('admin/field-session')
  @UseGuards(HfgAdminGuard)
  async adminFieldSession(
    @HfgAdminId() adminId: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const field = await this.judgeAuth.openLinkedSession(
      adminId,
      String(request.headers['user-agent'] ?? 'admin console'),
      request.ip ?? '',
      response,
    );
    if (!field) throw new UnauthorizedException('Admin account is not active');
    return { field };
  }
}
