import { SignJWT, jwtVerify, JWTPayload } from 'jose';
import { hfgConfig } from './hfg.config';

// The module signs its own short-lived access tokens for athlete and admin
// sessions. Uses `jose` (already a dependency of the host app) rather than the
// original module's `jsonwebtoken`, but keeps the same claim shape:
//   { typ: 'athlete' | 'admin', sub: <uuid>, role?: string }

const secret = new TextEncoder().encode(hfgConfig.jwtSecret);

export type HfgTokenType = 'athlete' | 'admin';

export interface HfgTokenPayload extends JWTPayload {
  typ: HfgTokenType;
  sub: string;
  role?: string;
}

export async function signAccess(
  typ: HfgTokenType,
  sub: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  return new SignJWT({ typ, ...extra })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime(hfgConfig.accessTtl)
    .sign(secret);
}

export async function verifyAccess(token: string): Promise<HfgTokenPayload> {
  const { payload } = await jwtVerify(token, secret);
  return payload as HfgTokenPayload;
}
