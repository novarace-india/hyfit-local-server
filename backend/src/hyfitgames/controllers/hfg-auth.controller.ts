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
import { HfgAdminId } from '../decorators/hfg-user.decorator';
import { HfgDbService } from '../hfg-db.service';
import { hfgConfig } from '../hfg.config';
import { signAccess } from '../hfg-jwt.util';
import { HfgOtpService } from '../services/hfg-otp.service';
import { HjudgeAuthService } from '../../hyfit-judge/services/hjudge-auth.service';
import { publicAthlete } from '../hfg.util';

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

  // Two token stores, because the two identities live in two schemas since 080:
  // an athlete is a row on the athlete platform, a console operator is a row in
  // hyfit_v2. Each token is written beside the row it belongs to, so neither
  // table carries a foreign key it cannot satisfy.
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
        `INSERT INTO refresh_tokens (athlete_id, token_hash, expires_at)
         VALUES ($1, $2, now() + ($3 || ' days')::interval)`,
        [opts.athleteId ?? null, hash, hfgConfig.refreshTtlDays],
      );
    }
    return raw;
  }

  /* POST /api/hyfitgames/auth/otp/request  { mobile } */
  @Post('otp/request')
  async otpRequest(@Body() body: { mobile?: string }) {
    const mobile = this.otp.normalizeMobile(body.mobile);
    if (!mobile) throw new BadRequestException('Enter a valid mobile number');

    const { rows } = await this.db.q(
      'SELECT id FROM athletes WHERE mobile = $1 AND is_active',
      [mobile],
    );
    if (!rows.length)
      throw new BadRequestException(
        'This number is not registered. Contact the organiser.',
      );
    await this.otp.requestOtp(mobile);
    return { ok: true, message: 'OTP sent' };
  }

  /* POST /api/hyfitgames/auth/otp/verify  { mobile, code } */
  @Post('otp/verify')
  async otpVerify(@Body() body: { mobile?: string; code?: string }) {
    const mobile = this.otp.normalizeMobile(body.mobile);
    if (!mobile || !/^\d{6}$/.test(String(body.code || '')))
      throw new BadRequestException('Enter the 6-digit OTP');

    const { rows } = await this.db.q(
      'SELECT * FROM athletes WHERE mobile = $1 AND is_active',
      [mobile],
    );
    const athlete = rows[0];

    if (!athlete)
      throw new BadRequestException(
        'This number is not registered. Contact the organiser.',
      );

    await this.otp.verifyOtp(mobile, body.code);
    const accessToken = await signAccess('athlete', athlete.id);
    const refreshToken = await this.issueRefresh({ athleteId: athlete.id });
    return { accessToken, refreshToken, athlete: publicAthlete(athlete) };
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
        throw new UnauthorizedException('Session expired — please log in again');
      const accessToken = await signAccess('admin', token.user_id, {
        role: a[0].role,
      });
      const refreshToken = await this.issueRefresh({ adminId: token.user_id });
      return { accessToken, refreshToken };
    }

    const { rows } = await this.db.q(
      `SELECT * FROM refresh_tokens
        WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()`,
      [hash],
    );
    const t = rows[0];
    if (!t)
      throw new UnauthorizedException('Session expired — please log in again');

    // rotate
    await this.db.q(
      'UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1',
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
      'UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1',
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
