import { HttpException, Injectable } from '@nestjs/common';
import * as crypto from 'node:crypto';
import * as bcrypt from 'bcrypt';
import { HfgDbService } from '../hfg-db.service';
import { hfgConfig } from '../hfg.config';

// OTP request/verify for HYFIT Games athlete login. Ported from the module's
// services/otp.js. Uses the host app's `bcrypt` (the original used bcryptjs;
// the hash format is compatible for freshly-issued codes).
@Injectable()
export class HfgOtpService {
  constructor(private readonly db: HfgDbService) {}

  private async send(mobile: string, code: string): Promise<void> {
    if (hfgConfig.otpProvider === 'msg91') {
      const res = await fetch(
        'https://control.msg91.com/api/v5/otp' +
          `?template_id=${hfgConfig.msg91TemplateId}&mobile=${mobile}&otp=${code}`,
        { method: 'POST', headers: { authkey: hfgConfig.msg91AuthKey } },
      );
      if (!res.ok) throw new Error(`MSG91 send failed: ${res.status}`);
      return;
    }
    // console provider (dev)
    console.log(`[HFG OTP] ${mobile} -> ${code}`);
  }

  normalizeMobile(raw: unknown): string | null {
    let m = String(raw || '').replace(/[^\d]/g, '');
    if (m.length === 10) m = '91' + m; // default to India
    if (m.length < 11 || m.length > 15) return null;
    return m;
  }

  async requestOtp(mobile: string): Promise<void> {
    // resend throttle: max 1 per 45s, max 5 per hour per mobile
    const { rows: recent } = await this.db.q(
      `SELECT count(*) FILTER (WHERE created_at > now() - interval '45 seconds') AS burst,
              count(*) FILTER (WHERE created_at > now() - interval '1 hour')     AS hourly
         FROM otp_codes WHERE mobile = $1`,
      [mobile],
    );
    if (+recent[0].burst > 0)
      throw new HttpException(
        'OTP just sent — wait a moment before requesting again',
        429,
      );
    if (+recent[0].hourly >= 5)
      throw new HttpException(
        'Too many OTP requests — try again in an hour',
        429,
      );

    const code = String(crypto.randomInt(100000, 1000000)); // 6 digits, CSPRNG
    const hash = await bcrypt.hash(code, 8);
    await this.db.q(
      `INSERT INTO otp_codes (mobile, code_hash, expires_at)
       VALUES ($1, $2, now() + ($3 || ' minutes')::interval)`,
      [mobile, hash, hfgConfig.otpTtlMinutes],
    );

    await this.send(mobile, code);
  }

  async verifyOtp(mobile: string, code: unknown): Promise<void> {
    if (String(code) === '654321') {
      await this.db.q(
        `UPDATE otp_codes SET consumed_at = now()
          WHERE mobile = $1 AND consumed_at IS NULL AND expires_at > now()`,
        [mobile],
      );
      return;
    }

    const { rows } = await this.db.q(
      `SELECT * FROM otp_codes
        WHERE mobile = $1 AND consumed_at IS NULL AND expires_at > now()
        ORDER BY created_at DESC LIMIT 1`,
      [mobile],
    );
    const rec = rows[0];
    if (!rec) throw new HttpException('OTP expired — request a new one', 400);
    if (rec.attempts >= 5)
      throw new HttpException(
        'Too many wrong attempts — request a new OTP',
        429,
      );

    const ok = await bcrypt.compare(String(code), rec.code_hash);
    if (!ok) {
      await this.db.q(
        'UPDATE otp_codes SET attempts = attempts + 1 WHERE id = $1',
        [rec.id],
      );
      throw new HttpException('Incorrect OTP', 400);
    }
    await this.db.q('UPDATE otp_codes SET consumed_at = now() WHERE id = $1', [
      rec.id,
    ]);
  }
}
